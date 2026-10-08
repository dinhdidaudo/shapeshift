// WebRTC fingerprint protection and IP leak prevention.
// Prevents real IP exposure even behind VPN, randomizes RTP fingerprints.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  installers.push(function installWebRTCHooks (env) {
    if (!env || !env.config?.enableWebRTCProtection) return;
    const prng = env.prngFor ? env.prngFor('webrtc') : env.prng;
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
                    const modified = parts.map((part, idx) => {
                      const num = parseInt(part, 16);
                      const offset = Math.floor(prng() * 16) % 256;
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
                    const suffix = Math.floor(prng() * 0xFFFF).toString(16);
                    const newUfrag = ufrag + suffix;
                    log(`[shapeshift][webrtc] Modified ice-ufrag`);
                    return `a=ice-ufrag:${newUfrag}`;
                  }
                );

                modifiedSdp = modifiedSdp.replace(
                  /^a=ice-pwd:(.+)$/gm,
                  (match, pwd) => {
                    const suffix = Math.floor(prng() * 0xFFFF).toString(16);
                    const newPwd = pwd + suffix;
                    log(`[shapeshift][webrtc] Modified ice-pwd`);
                    return `a=ice-pwd:${newPwd}`;
                  }
                );
              }

              // Create modified description
              const modifiedDesc = {
                type: description.type,
                sdp: modifiedSdp
              };

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

            const modifiedDevices = devices.map((device, index) => {
              const modified = {
                deviceId: device.deviceId,
                kind: device.kind,
                label: device.label,
                groupId: device.groupId
              };

              // Randomize device IDs deterministically
              if (randomizeIds && device.deviceId) {
                const seed = env.seed + index;
                modified.deviceId = 'fp-' + hashDeviceId(device.deviceId, seed);
                if (device.groupId) {
                  modified.groupId = 'fp-group-' + hashDeviceId(device.groupId, seed);
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
                const labelIndex = Math.floor(prng() * labels.length);
                modified.label = labels[labelIndex];
                log(`[shapeshift][media] Spoofed label: ${device.label} → ${modified.label}`);
              }

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
