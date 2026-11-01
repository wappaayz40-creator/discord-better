/* ============================================================
   Fleek · voice channels and screen share
   Peer-to-peer WebRTC (mesh) with the Worker used only as a
   signalling relay. No media ever touches the server and nothing
   is recorded.

   Structure: every pair of people keeps one RTCPeerConnection.
   The peer with the smaller user id offers, the other answers.
   Both sides negotiate an audio and a video transceiver up front,
   so starting a screen share is just replaceTrack() — no
   renegotiation, and no lost connections mid-share.
   ============================================================ */

window.FleekVoice = (function () {
  "use strict";

  var cfg = null;
  var peers = {}; // sub -> { pc, ready, queued, stream, videoSender, audio, offering }
  var signalTimer = null;
  var pingTimer = null;
  var cursor = 0;

  var st = {
    channelId: null,
    joined: false,
    muted: false,
    sharing: false,
    participants: [],
    speaking: {},
    localStream: null,
    screenStream: null,
    error: "",
    connection: "",
  };

  var audioCtx = null;
  var localAnalyser = null;
  var remoteAnalysers = {};
  var voiceTimer = null;
  var lastSpeaking = {};

  /* ----------------------------------------------------------
     Speaking detection — an analyser per stream, sampled a few
     times a second so the green ring follows the loudest voice.
     ---------------------------------------------------------- */

  function ensureAudioCtx() {
    if (!audioCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      try {
        audioCtx = new Ctx();
      } catch (error) {
        return null;
      }
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(function () {});
    return audioCtx;
  }

  function watchStream(sub, stream) {
    var ctx = ensureAudioCtx();
    if (!ctx || !stream || !stream.getAudioTracks().length) return;
    try {
      var source = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      var entry = { analyser: analyser, data: new Uint8Array(analyser.fftSize) };
      if (sub === self().sub) localAnalyser = entry;
      else remoteAnalysers[sub] = entry;
    } catch (error) {
      /* a stream that can't be analysed just never lights up */
    }
  }

  function level(entry) {
    if (!entry) return 0;
    entry.analyser.getByteTimeDomainData(entry.data);
    var sum = 0;
    for (var i = 0; i < entry.data.length; i += 1) {
      var value = (entry.data[i] - 128) / 128;
      sum += value * value;
    }
    return Math.sqrt(sum / entry.data.length);
  }

  function sampleSpeaking() {
    if (!st.joined) return;
    var next = {};

    if (!st.muted && level(localAnalyser) > 0.03) next[self().sub] = true;

    Object.keys(remoteAnalysers).forEach(function (sub) {
      if (level(remoteAnalysers[sub]) > 0.035) next[sub] = true;
    });

    var changed =
      Object.keys(next).length !== Object.keys(lastSpeaking).length ||
      Object.keys(next).some(function (key) {
        return !lastSpeaking[key];
      });

    lastSpeaking = next;
    st.speaking = next;
    if (changed) emit();
  }

  function tone(freq, duration, delay, type) {
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    var start = ctx.currentTime + (delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.07, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }

  function soundMute() {
    tone(440, 0.09, 0, "triangle");
    tone(300, 0.12, 0.1, "triangle");
  }

  function soundUnmute() {
    tone(320, 0.09, 0, "triangle");
    tone(520, 0.12, 0.1, "triangle");
  }

  function soundJoin() {
    tone(392, 0.1, 0, "sine");
    tone(587, 0.14, 0.11, "sine");
  }

  function soundLeave() {
    tone(523, 0.1, 0, "sine");
    tone(349, 0.16, 0.11, "sine");
  }

  var ICE = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];

  function init(options) {
    cfg = options;
  }

  function self() {
    return cfg && cfg.self ? cfg.self() : { sub: "" };
  }

  function emit() {
    if (cfg && cfg.onUpdate) cfg.onUpdate();
  }

  function snapshot() {
    return st;
  }

  function streamFor(sub) {
    return peers[sub] ? peers[sub].stream : null;
  }

  function isJoined(channelId) {
    return st.joined && st.channelId === channelId;
  }

  /* ----------------------------------------------------------
     Signalling
     ---------------------------------------------------------- */

  function send(to, kind, payload) {
    if (!st.channelId) return Promise.resolve();
    return cfg
      .api("/api/voice/signal", {
        method: "POST",
        body: JSON.stringify({ channel: st.channelId, to: to, kind: kind, payload: payload }),
      })
      .catch(function () {});
  }

  function peerFor(sub) {
    if (peers[sub]) return peers[sub];

    var pc = new RTCPeerConnection({ iceServers: ICE });
    var entry = {
      pc: pc,
      ready: false,
      queued: [],
      stream: new MediaStream(),
      videoSender: null,
      audio: null,
      offering: false,
      negotiated: false,
    };
    peers[sub] = entry;

    pc.onicecandidate = function (event) {
      if (event.candidate) send(sub, "ice", event.candidate.toJSON());
    };

    pc.ontrack = function (event) {
      entry.stream.addTrack(event.track);
      if (event.track.kind === "audio") {
        if (!entry.audio) {
          var audio = document.createElement("audio");
          audio.autoplay = true;
          audio.setAttribute("playsinline", "");
          audio.style.display = "none";
          document.body.appendChild(audio);
          entry.audio = audio;
        }
        entry.audio.srcObject = new MediaStream([event.track]);
        entry.audio.play().catch(function () {});
        watchStream(sub, new MediaStream([event.track]));
      }
      emit();
    };

    pc.onconnectionstatechange = function () {
      st.connection = pc.connectionState;
      emit();
    };

    return entry;
  }

  /* The offering side creates the audio and video m-lines. */
  function addTransceivers(entry) {
    if (entry.negotiated) return;
    entry.negotiated = true;

    // Audio: send the mic if we have one, otherwise just listen.
    var audioTx = entry.pc.addTransceiver("audio", { direction: st.localStream ? "sendrecv" : "recvonly" });
    if (st.localStream) {
      var mic = st.localStream.getAudioTracks()[0];
      if (mic) audioTx.sender.replaceTrack(mic).catch(function () {});
    }

    // Video: always negotiated, silent until someone shares a screen.
    var videoTx = entry.pc.addTransceiver("video", { direction: "sendrecv" });
    entry.videoSender = videoTx.sender;
    if (st.screenStream) {
      var screen = st.screenStream.getVideoTracks()[0];
      if (screen) videoTx.sender.replaceTrack(screen).catch(function () {});
    }
  }

  /* The answering side must NOT add transceivers: the offer already created
     them. It reuses those, flips them to sendrecv and attaches its own mic and
     screen. Adding new ones here is what makes audio one-way. */
  function adoptTransceivers(entry) {
    entry.pc.getTransceivers().forEach(function (tx) {
      var kind = "";
      if (tx.receiver && tx.receiver.track) kind = tx.receiver.track.kind;
      else if (tx.sender && tx.sender.track) kind = tx.sender.track.kind;

      if (kind === "audio") {
        var mic = st.localStream ? st.localStream.getAudioTracks()[0] : null;
        tx.direction = mic ? "sendrecv" : "recvonly";
        if (mic) tx.sender.replaceTrack(mic).catch(function () {});
      }

      if (kind === "video") {
        tx.direction = "sendrecv";
        entry.videoSender = tx.sender;
        var screen = st.screenStream ? st.screenStream.getVideoTracks()[0] : null;
        if (screen) tx.sender.replaceTrack(screen).catch(function () {});
      }
    });
  }

  function flush(entry) {
    var queued = entry.queued.splice(0);
    queued.forEach(function (candidate) {
      entry.pc.addIceCandidate(candidate).catch(function () {});
    });
  }

  function createOffer(sub) {
    var entry = peerFor(sub);
    if (entry.offering || entry.pc.signalingState !== "stable") return;
    entry.offering = true;
    addTransceivers(entry);

    entry.pc
      .createOffer()
      .then(function (offer) {
        return entry.pc.setLocalDescription(offer).then(function () {
          return send(sub, "offer", { type: offer.type, sdp: offer.sdp });
        });
      })
      .catch(function () {})
      .then(function () {
        entry.offering = false;
      });
  }

  function dropPeer(sub) {
    var entry = peers[sub];
    if (!entry) return;
    delete peers[sub];
    delete remoteAnalysers[sub];
    try {
      entry.pc.close();
    } catch (error) {
      /* already closed */
    }
    if (entry.audio && entry.audio.parentNode) entry.audio.parentNode.removeChild(entry.audio);
  }

  function handleSignal(signal) {
    var sub = signal.from;
    var payload = signal.payload;
    try {
      payload = JSON.parse(signal.payload);
    } catch (error) {
      return;
    }

    if (signal.kind === "bye") {
      dropPeer(sub);
      emit();
      return;
    }

    if (signal.kind === "offer") {
      var entry = peerFor(sub);
      return entry.pc
        .setRemoteDescription({ type: "offer", sdp: payload.sdp })
        .then(function () {
          entry.ready = true;
          flush(entry);
          adoptTransceivers(entry);
          return entry.pc.createAnswer();
        })
        .then(function (answer) {
          return entry.pc.setLocalDescription(answer).then(function () {
            return send(sub, "answer", { type: answer.type, sdp: answer.sdp });
          });
        })
        .catch(function () {});
    }

    if (signal.kind === "answer") {
      var waiting = peers[sub];
      if (!waiting || waiting.pc.signalingState !== "have-local-offer") return;
      return waiting.pc
        .setRemoteDescription({ type: "answer", sdp: payload.sdp })
        .then(function () {
          waiting.ready = true;
          flush(waiting);
        })
        .catch(function () {});
    }

    if (signal.kind === "ice") {
      var ice = peers[sub];
      if (!ice) return;
      if (!ice.ready) {
        ice.queued.push(payload);
        return;
      }
      return ice.pc.addIceCandidate(payload).catch(function () {});
    }
  }

  function poll() {
    if (!st.joined || !st.channelId || document.hidden) return;
    var channel = st.channelId;

    cfg
      .api("/api/voice/signals?channel=" + encodeURIComponent(channel) + "&since=" + cursor)
      .then(function (result) {
        cursor = result.cursor || cursor;
        var chain = Promise.resolve();
        result.signals.forEach(function (signal) {
          chain = chain.then(function () {
            return handleSignal(signal);
          });
        });
      })
      .catch(function () {});
  }

  /* ----------------------------------------------------------
     Presence
     ---------------------------------------------------------- */

  function signature(list) {
    return (list || [])
      .map(function (person) {
        return person.sub + (person.muted ? "m" : "") + (person.sharing ? "s" : "");
      })
      .sort()
      .join(",");
  }

  function reconcile(participants) {
    var subs = (participants || []).map(function (person) {
      return person.sub;
    });

    Object.keys(peers).forEach(function (sub) {
      if (subs.indexOf(sub) === -1) dropPeer(sub);
    });

    var mine = self().sub;
    subs.forEach(function (sub) {
      if (sub === mine) return;
      // Deterministic: the smaller id offers, so only one side tries.
      if (mine < sub && !peers[sub]) createOffer(sub);
    });
  }

  function ping() {
    if (!st.joined || !st.channelId) return;
    cfg
      .api("/api/voice/ping", {
        method: "POST",
        body: JSON.stringify({ channel: st.channelId, muted: st.muted, sharing: st.sharing }),
      })
      .then(function (result) {
        var changed = signature(result.participants) !== signature(st.participants);
        st.participants = result.participants;
        reconcile(result.participants);
        if (changed) emit();
      })
      .catch(function (error) {
        if (error.status === 403 || error.status === 404) leave();
      });
  }

  /* ----------------------------------------------------------
     Join / leave / controls
     ---------------------------------------------------------- */

  function startTimers() {
    stopTimers();
    signalTimer = setInterval(poll, 1000);
    pingTimer = setInterval(ping, 5000);
    voiceTimer = setInterval(sampleSpeaking, 160);
    poll();
    ping();
    sampleSpeaking();
  }

  function stopTimers() {
    clearInterval(signalTimer);
    clearInterval(pingTimer);
    clearInterval(voiceTimer);
    signalTimer = null;
    pingTimer = null;
    voiceTimer = null;
  }

  function stopLocal() {
    if (st.localStream) {
      st.localStream.getTracks().forEach(function (track) {
        track.stop();
      });
    }
    st.localStream = null;
  }

  function join(channelId) {
    if (st.joined && st.channelId === channelId) return Promise.resolve(st);

    var previous = st.channelId;
    var wasJoined = st.joined;
    if (wasJoined && previous) leave();

    st.channelId = channelId;
    st.joined = true;
    st.error = "";
    st.muted = false;
    st.sharing = false;
    st.participants = [];
    st.connection = "";
    peers = {};
    cursor = 0;

    var mic = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices
          .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
          .catch(function () {
            st.localStream = null;
            st.muted = true;
            st.error = "Microphone blocked — you joined listen-only.";
            return null;
          })
      : Promise.resolve(null);

    return mic
      .then(function (stream) {
        if (stream) st.localStream = stream;
        if (stream) watchStream(self().sub, stream);

        return cfg.api("/api/voice/join", {
          method: "POST",
          body: JSON.stringify({ channel: channelId }),
        });
      })
      .then(function (result) {
        st.participants = result.participants || [];
        startTimers();
        reconcile(st.participants);
        soundJoin();
        emit();
        return st;
      })
      .catch(function (error) {
        st.joined = false;
        st.channelId = null;
        st.error = error.message;
        st.participants = [];
        stopLocal();
        emit();
        return st;
      });
  }

  function leave() {
    var channel = st.channelId;
    var wasJoined = st.joined;

    if (wasJoined) soundLeave();
    stopTimers();
    Object.keys(peers).forEach(dropPeer);
    peers = {};
    stopLocal();

    if (st.screenStream) {
      st.screenStream.getTracks().forEach(function (track) {
        track.stop();
      });
    }

    st.screenStream = null;
    st.joined = false;
    st.channelId = null;
    st.participants = [];
    st.speaking = {};
    st.muted = false;
    st.sharing = false;
    st.error = "";
    st.connection = "";
    localAnalyser = null;
    remoteAnalysers = {};
    lastSpeaking = {};
    cursor = 0;

    if (wasJoined && channel && cfg) {
      cfg.api("/api/voice/leave", { method: "POST", body: JSON.stringify({ channel: channel }) }).catch(function () {});
    }

    emit();
  }

  function toggleMute() {
    st.muted = !st.muted;
    if (st.localStream) {
      st.localStream.getAudioTracks().forEach(function (track) {
        track.enabled = !st.muted;
      });
    }
    if (st.muted) soundMute();
    else soundUnmute();

    ping();
    emit();
    return st.muted;
  }

  function stopShare() {
    if (st.screenStream) {
      st.screenStream.getTracks().forEach(function (track) {
        track.stop();
      });
    }
    st.screenStream = null;
    st.sharing = false;

    Object.keys(peers).forEach(function (sub) {
      if (peers[sub].videoSender) peers[sub].videoSender.replaceTrack(null).catch(function () {});
    });

    if (st.joined) ping();
    emit();
  }

  function toggleShare() {
    if (st.sharing) {
      stopShare();
      return Promise.resolve(false);
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      st.error = "This browser can't share a screen.";
      emit();
      return Promise.resolve(false);
    }

    return navigator.mediaDevices
      .getDisplayMedia({ video: { frameRate: 30 }, audio: false })
      .then(function (stream) {
        st.screenStream = stream;
        st.sharing = true;

        var track = stream.getVideoTracks()[0];
        Object.keys(peers).forEach(function (sub) {
          if (peers[sub].videoSender) peers[sub].videoSender.replaceTrack(track).catch(function () {});
        });

        track.addEventListener("ended", function () {
          stopShare();
        });

        ping();
        emit();
        return true;
      })
      .catch(function () {
        st.error = "Screen share was cancelled.";
        emit();
        return false;
      });
  }

  /* ----------------------------------------------------------
     Video elements rendered by the app
     ---------------------------------------------------------- */

  function attachMedia(root) {
    if (!root) return;

    root.querySelectorAll("[data-voice-video]").forEach(function (el) {
      var sub = el.getAttribute("data-voice-video");
      var stream = streamFor(sub);
      if (stream && el.srcObject !== stream) {
        el.srcObject = stream;
        var played = el.play();
        if (played && played.catch) played.catch(function () {});
      }
    });

    root.querySelectorAll("[data-voice-self]").forEach(function (el) {
      if (st.screenStream && el.srcObject !== st.screenStream) {
        el.srcObject = st.screenStream;
        var played = el.play();
        if (played && played.catch) played.catch(function () {});
      }
    });
  }

  window.addEventListener("pagehide", function () {
    if (st.joined) leave();
  });

  return {
    init: init,
    join: join,
    leave: leave,
    toggleMute: toggleMute,
    toggleShare: toggleShare,
    stopShare: stopShare,
    snapshot: snapshot,
    isJoined: isJoined,
    streamFor: streamFor,
    attachMedia: attachMedia,
  };
})();
