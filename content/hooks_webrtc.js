// WebRTC fingerprint protection and IP leak prevention.
// Prevents real IP exposure even behind VPN, randomizes RTP fingerprints.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installWebRTCHooks (env) {
    if (!env || !env.config?.enableWebRTCProtection) return;
    const { config } = env;
    const blockIPLeak = config.webrtc?.blockIPLeak !== false;
    const randomizeSDP = config.webrtc?.randomizeSDP !== false;
    const forceRelay = config.webrtc?.forceRelay === true;
    const debug = config.debug ? true : false;
    const log = debug ? console.log : () => {};

    function safeWrap (fn) {
      try {
        fn();
      } catch (e) {
        if (debug) console.error('[shapeshift][webrtc] Hook failed:', e);
      }
    }

    // P1 2.2/2.3: SDP fingerprint bytes, ICE credential suffixes and device
    // labels used to be drawn from the streaming PRNG inside each call, so two
    // setLocalDescription/enumerateDevices calls disagreed and the same SDP in
    // produced a different SDP out. Key them on (seed, input) instead, exactly
    // like the media and WebGL surfaces already do.
    const webrtcHash = globalThis.ssHashString;
    function stableRoll (label, input) {
      if (!webrtcHash) return 0.5;
      return webrtcHash(((env.seed >>> 0) || 0) + ':webrtc:' + label + ':' + input) / 4294967296;
    }

    safeWrap(() => {
      if (!window.RTCPeerConnection) return;

      const OrigRTCPeerConnection = window.RTCPeerConnection;

      // Proxy RTCPeerConnection constructor
      window.RTCPeerConnection = function (configuration, constraints) {
        // Track statistics
        if (globalThis.ssStatsTracker) {
          globalThis.ssStatsTracker.increment('webrtcCalls');
        }

        log('[shapeshift][webrtc] RTCPeerConnection created');

        // Modify configuration to force relay if enabled
        if (forceRelay && configuration) {
          configuration.iceTransportPolicy = 'relay';
          log('[shapeshift][webrtc] Forced relay-only ICE');
        }

        const pc = new OrigRTCPeerConnection(configuration, constraints);

        // Hook createOffer
        const origCreateOffer = pc.createOffer;
        if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origCreateOffer)) {
          globalThis.ssStealth.markPatched(origCreateOffer);
          pc.createOffer = function (options) {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }

            // Force relay candidates if configured
            if (forceRelay && options) {
              options.iceTransportPolicy = 'relay';
            }

            log('[shapeshift][webrtc] createOffer called');
            return origCreateOffer.apply(this, arguments);
          };
        }

        // Hook createAnswer
        const origCreateAnswer = pc.createAnswer;
        if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origCreateAnswer)) {
          globalThis.ssStealth.markPatched(origCreateAnswer);
          pc.createAnswer = function (options) {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }

            log('[shapeshift][webrtc] createAnswer called');
            return origCreateAnswer.apply(this, arguments);
          };
        }

        // Hook setLocalDescription to filter SDP
        const origSetLocalDescription = pc.setLocalDescription;
        if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origSetLocalDescription)) {
          globalThis.ssStealth.markPatched(origSetLocalDescription);
          pc.setLocalDescription = function (description) {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }

            if (description && description.sdp) {
              let modifiedSdp = description.sdp;

              // Block IP leak: drop host and srflx candidates.
              // Replacing a whole line with '' leaves a blank line behind, which
              // both corrupts the SDP layout and makes the before/after line
              // count identical (so `removed` was always 0). Filter the lines
              // out instead and count what was actually dropped.
              if (blockIPLeak) {
                const lines = modifiedSdp.split('\n');
                const kept = [];
                let removed = 0;
                for (const line of lines) {
                  if (/^a=candidate:/.test(line) && (/ typ host( |$)/.test(line) || / typ srflx( |$)/.test(line))) {
                    removed++;
                    continue;
                  }
                  kept.push(line);
                }
                if (removed > 0) {
                  modifiedSdp = kept.join('\n');
                  log(`[shapeshift][webrtc] Removed ${removed} candidate lines to prevent IP leak`);
                }
              }

              // Randomize SDP fingerprints
              if (randomizeSDP) {
                // Modify fingerprint values
                modifiedSdp = modifiedSdp.replace(
                  /^a=fingerprint:(\w+)\s+([0-9A-F:]+)$/gm,
                  (match, algorithm, fingerprint) => {
                    // Generate deterministic but different fingerprint
                    const parts = fingerprint.split(':');
                    const modified = parts.map((part) => {
                      const num = parseInt(part, 16);
                      const offset = Math.floor(stableRoll('fp', part) * 16) % 256;
                      const newNum = (num + offset) % 256;
                      return newNum.toString(16).toUpperCase().padStart(2, '0');
                    });
                    const newFingerprint = modified.join(':');
                    log(`[shapeshift][webrtc] Randomized fingerprint: ${fingerprint.substring(0, 20)}... → ${newFingerprint.substring(0, 20)}...`);
                    return `a=fingerprint:${algorithm} ${newFingerprint}`;
                  }
                );

                // Modify ICE credentials (ufrag and pwd)
                modifiedSdp = modifiedSdp.replace(
                  /^a=ice-ufrag:(.+)$/gm,
                  (match, ufrag) => {
                    const suffix = Math.floor(stableRoll('ufrag', ufrag) * 0xFFFF).toString(16);
                    const newUfrag = ufrag + suffix;
                    log(`[shapeshift][webrtc] Modified ice-ufrag`);
                    return `a=ice-ufrag:${newUfrag}`;
                  }
                );

                modifiedSdp = modifiedSdp.replace(
                  /^a=ice-pwd:(.+)$/gm,
                  (match, pwd) => {
                    const suffix = Math.floor(stableRoll('pwd', pwd) * 0xFFFF).toString(16);
                    const newPwd = pwd + suffix;
                    log(`[shapeshift][webrtc] Modified ice-pwd`);
                    return `a=ice-pwd:${newPwd}`;
                  }
                );
              }

              // P1 2.13: hand back a real RTCSessionDescription. A plain
              // {type, sdp} object breaks libraries (adapter.js,
              // mediasoup-client) that check instanceof or call methods on the
              // description before passing it on.
              let modifiedDesc;
              try {
                modifiedDesc = new RTCSessionDescription({ type: description.type, sdp: modifiedSdp });
              } catch (e) {
                modifiedDesc = { type: description.type, sdp: modifiedSdp };
              }

              return origSetLocalDescription.call(this, modifiedDesc);
            }

            return origSetLocalDescription.apply(this, arguments);
          };
        }

        // Hook setRemoteDescription
        const origSetRemoteDescription = pc.setRemoteDescription;
        if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origSetRemoteDescription)) {
          globalThis.ssStealth.markPatched(origSetRemoteDescription);
          pc.setRemoteDescription = function () {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }

            log('[shapeshift][webrtc] setRemoteDescription called');
            return origSetRemoteDescription.apply(this, arguments);
          };
        }

        // Hook addIceCandidate to filter candidates
        const origAddIceCandidate = pc.addIceCandidate;
        if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origAddIceCandidate)) {
          globalThis.ssStealth.markPatched(origAddIceCandidate);
          pc.addIceCandidate = function (candidate) {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }

            if (blockIPLeak && candidate && candidate.candidate) {
              // Block host and srflx candidates
              if (candidate.candidate.includes('typ host') ||
                  candidate.candidate.includes('typ srflx')) {
                log('[shapeshift][webrtc] Blocked ICE candidate:', candidate.candidate.substring(0, 50));
                // Return resolved promise without adding the candidate
                return Promise.resolve();
              }
            }

            return origAddIceCandidate.apply(this, arguments);
          };
        }

        return pc;
      };

      // Copy static properties
      Object.setPrototypeOf(window.RTCPeerConnection, OrigRTCPeerConnection);
      window.RTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;

      log('[shapeshift][webrtc] RTCPeerConnection hooked successfully');
    });

    // Hook getUserMedia to prevent device enumeration fingerprinting
    safeWrap(() => {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const origGetUserMedia = navigator.mediaDevices.getUserMedia;
        if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origGetUserMedia)) {
          globalThis.ssStealth.markPatched(origGetUserMedia);
          navigator.mediaDevices.getUserMedia = function () {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }
            log('[shapeshift][webrtc] getUserMedia called');
            return origGetUserMedia.apply(this, arguments);
          };
        }
      }
    });

    // Hook enumerateDevices to randomize device IDs and spoof labels
    if (config.enableMediaDeviceProtection) {
      safeWrap(() => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

        const origEnumerateDevices = navigator.mediaDevices.enumerateDevices;
        if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origEnumerateDevices)) {
          globalThis.ssStealth.markPatched(origEnumerateDevices);

          navigator.mediaDevices.enumerateDevices = async function () {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }

            const devices = await origEnumerateDevices.call(this);
            const randomizeIds = config.mediaDevices?.randomizeDeviceIds !== false;
            const spoofLabels = config.mediaDevices?.spoofDeviceLabels !== false;

            if (!randomizeIds && !spoofLabels) {
              return devices;
            }

            // Deterministic 32-bit FNV-1a style hash. The previous version used
            // `hash = hash & hash` (a no-op) and then Math.abs(), which collided
            // on the sign bit and produced a different value for negative hashes.
            // Force unsigned with >>> 0 so the output is stable and collision-free
            // across the full 32-bit space.
            function hashDeviceId(deviceId, seed) {
              let hash = (seed >>> 0) || 0x811c9dc5;
              for (let i = 0; i < deviceId.length; i++) {
                hash ^= deviceId.charCodeAt(i);
                hash = Math.imul(hash, 0x01000193) >>> 0;
              }
              return hash.toString(16).padStart(8, '0');
            }

            // P1: a plain object literal loses MediaDeviceInfo, so
            // `devices[0] instanceof MediaDeviceInfo` was false for every
            // entry and the `.toJSON()` method disappeared - a one-line
            // oracle. Build the copy on the real prototype instead and
            // only overwrite the fields that must change.
            const modifiedDevices = devices.map((device, index) => {
              const modified = Object.create(Object.getPrototypeOf(device));
              // P0: `modified.deviceId = value` silently did NOTHING. The real
              // field is a getter-only accessor on MediaDeviceInfo.prototype,
              // so a plain assignment on an object that inherits from it is
              // swallowed in sloppy mode and the page kept the REAL deviceId.
              // Install non-enumerable own accessors that shadow the prototype.
              const shadow = (key, value) => {
                try {
                  Object.defineProperty(modified, key, {
                    get: () => value, enumerable: false, configurable: true
                  });
                } catch (e) { /* ignore */ }
              };

              let deviceId = device.deviceId;
              let groupId = device.groupId;
              let label = device.label;

              // Randomize device IDs deterministically
              if (randomizeIds && device.deviceId) {
                const seed = env.seed + index;
                deviceId = 'ss-' + hashDeviceId(device.deviceId, seed);
                if (device.groupId) {
                  groupId = 'ss-group-' + hashDeviceId(device.groupId, seed);
                }
              }

              // Spoof device labels
              if (spoofLabels && device.label) {
                const genericLabels = {
                  audioinput: ['Microphone', 'Default Microphone', 'Internal Microphone'],
                  audiooutput: ['Speaker', 'Default Speaker', 'Internal Speaker'],
                  videoinput: ['Camera', 'Default Camera', 'Built-in Camera']
                };

                const labels = genericLabels[device.kind] || ['Device'];
                const labelIndex = Math.floor(stableRoll('label', device.deviceId || device.kind) * labels.length);
                label = labels[labelIndex];
                log(`[shapeshift][media] Spoofed label: ${device.label} → ${label}`);
              }

              shadow('deviceId', deviceId);
              shadow('groupId', groupId);
              shadow('kind', device.kind);
              shadow('label', label);

              return modified;
            });

            log(`[shapeshift][media] enumerateDevices: ${devices.length} devices, IDs randomized: ${randomizeIds}, labels spoofed: ${spoofLabels}`);
            return modifiedDevices;
          };

          log('[shapeshift][media] enumerateDevices hooked successfully');
        }
      });
    }
  });
})();
