// WebRTC fingerprint protection and IP leak prevention.
// Prevents real IP exposure even behind VPN, randomizes RTP fingerprints.
(function () {
  const installers = (globalThis.ssHookInstallers = globalThis.ssHookInstallers || []);

  // P2 7.2 (WebRTC mode): the three overlapping booleans are collapsed into one
  // tri-state. `off` is the pass-through, `block-host-srflx` strips the
  // candidates that carry an address, and `relay-only` is the strictest.
  // A config written by an older build has no `mode`, so the effective value is
  // derived from the legacy booleans. page_world_injector.js runs the identical
  // derivation, which is what keeps the two worlds from disagreeing.
  const WEBRTC_MODES = ['off', 'block-host-srflx', 'relay-only'];
  function effectiveWebrtcMode (group) {
    const g = group || {};
    if (WEBRTC_MODES.indexOf(g.mode) !== -1) return g.mode;
    if (g.forceRelay === true) return 'relay-only';
    if (g.blockIPLeak === false) return 'off';
    return 'block-host-srflx';
  }

  installers.push(function installWebRTCHooks (env) {
    if (!env || !env.config?.enableWebRTCProtection) return;
    const { config } = env;
    // P2 7.2: one explicit policy replaces the overlapping booleans. `off` is a
    // real pass-through - the page keeps its native SDP - so the switch is no
    // longer a no-op that still looked active. The two protected modes both
    // strip address-bearing candidates; `relay-only` additionally pins
    // iceTransportPolicy so no host candidate is gathered at all.
    const webrtcMode = effectiveWebrtcMode(config.webrtc);
    const blockIPLeak = webrtcMode !== 'off';
    const forceRelay = webrtcMode === 'relay-only';
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

        // Never mutate the caller's configuration object: the page owns it, may
        // have frozen it, and may read it back to see what it passed. Build a
        // private copy when the relay policy has to be forced.
        let effectiveConfiguration = configuration;
        if (forceRelay) {
          effectiveConfiguration = Object.assign({}, configuration || {}, {
            iceTransportPolicy: 'relay'
          });
          log('[shapeshift][webrtc] Forced relay-only ICE');
        }

        const pc = new OrigRTCPeerConnection(effectiveConfiguration, constraints);

        // Hook createOffer
        const origCreateOffer = pc.createOffer;
        if (globalThis.ssStealth && !globalThis.ssStealth.isPatched(origCreateOffer)) {
          globalThis.ssStealth.markPatched(origCreateOffer);
          pc.createOffer = function (options) {
            if (globalThis.ssTimingUtils) {
              globalThis.ssTimingUtils.randomDelaySync();
            }

            // Force relay candidates if configured. Same rule as the
            // constructor: pass a copy, never mutate the page's options object.
            if (forceRelay && options) {
              arguments[0] = Object.assign({}, options, { iceTransportPolicy: 'relay' });
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
                // SDP is CRLF-terminated; splitting on '\n' leaves a trailing
                // '\r' on every line, so / typ host( |$)/ never matched and no
                // candidate was ever removed. Split on both terminators.
                const lines = modifiedSdp.split(/\r?\n/);
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

              // P0: the `a=fingerprint:` DTLS line and `a=ice-ufrag` / `a=ice-pwd`
              // are the handshake credentials themselves. Rewriting any of them
              // (as this file used to, and as MAIN world already stopped doing)
              // makes the SDP inconsistent with what the browser will actually
              // negotiate: ICE never authenticates, DTLS never validates the peer
              // certificate, and every real call silently fails. `randomizeSDP`
              // therefore no longer touches the credential lines; the SDP it can
              // still safely scrub is the candidate list above.

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

            // P1: the blocked path returned a bare Promise, so the caller could
            // not tell whether the candidate had actually been added and any
            // `await addIceCandidate(x)` resolved a tick early. Hand back the
            // native call's own promise when the candidate is allowed through,
            // and a resolved promise shaped like it when the candidate is
            // dropped - never a different thenable identity than the native one.
            const raw = candidate && typeof candidate === 'object' ? candidate.candidate : null;
            if (blockIPLeak && typeof raw === 'string' &&
                (raw.indexOf('typ host') !== -1 || raw.indexOf('typ srflx') !== -1)) {
              log('[shapeshift][webrtc] Blocked ICE candidate:', raw.substring(0, 50));
              // P1 3.3: this branch used to hand back a bare Promise.resolve(),
              // which is a different thenable identity than the native method's
              // promise and can never reject - a one-line shape oracle. Call the
              // native method with no candidate (a legal no-op that resolves) so
              // the caller still gets a real native promise; fall back only if
              // even that throws.
              try {
                return origAddIceCandidate.call(this);
              } catch (e) {
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

            // Deterministic 32-bit FNV-1a over the whole input, starting from the
            // FNV offset basis. P1 (world split): this used to seed the fold with
            // the numeric seed and hash a different string than MAIN, so the page
            // and this copy reported two different deviceIds for one device -
            // exactly the contradiction the shim exists to prevent. This is now
            // byte-identical to page_world_injector.js.
            function hashDeviceId(value) {
              let hash = 0x811c9dc5;
              const s = String(value);
              for (let i = 0; i < s.length; i++) {
                hash ^= s.charCodeAt(i);
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

              // Randomize device IDs deterministically.
              // P1 (world split): this used `env.seed + index`, so the ISOLATED
              // copy of enumerateDevices reported a different deviceId for the
              // same physical device than the MAIN-world hook - two answers for
              // one page. Key it on (seed, kind, deviceId), exactly like
              // page_world_injector.js does, so both worlds agree.
              if (randomizeIds && device.deviceId) {
                // Same key and same hash as page_world_injector.js: ':dev:'
                // carries the kind, ':grp:' deliberately does not.
                deviceId = 'ss-' + hashDeviceId(((env.seed >>> 0) || 0) + ':dev:' + device.kind + ':' + device.deviceId);
                if (device.groupId) {
                  groupId = 'ss-group-' + hashDeviceId(((env.seed >>> 0) || 0) + ':grp:' + device.groupId);
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
                // Same key as MAIN: ':label:' over the real deviceId (or kind),
                // taken modulo the list. The old path rolled a 0..1 fraction off
                // a different ':webrtc:' stream, so the two worlds chose
                // different labels for one device.
                const labelHash = webrtcHash || globalThis.ssHashString;
                label = labels[labelHash(((env.seed >>> 0) || 0) + ':label:' + (device.deviceId || device.kind)) % labels.length];
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
