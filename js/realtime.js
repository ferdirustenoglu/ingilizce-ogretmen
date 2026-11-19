// Canlı Sohbet: OpenAI Realtime API ile WebRTC bağlantısı
// Akış: geçici anahtar (client_secrets) → RTCPeerConnection + mikrofon + "oai-events" veri kanalı
//       → SDP teklifi /v1/realtime/calls → olaylar veri kanalından gelir.

const BASE = 'https://api.openai.com/v1';

// Tahmini fiyatlar (1M token başına, USD)
const RT_PRICES = {
  mini: { textIn: 0.6, textCached: 0.06, audioIn: 10, audioCached: 0.3, textOut: 2.4, audioOut: 20 },
  large: { textIn: 4, textCached: 0.4, audioIn: 32, audioCached: 0.4, textOut: 16, audioOut: 64 },
};

export function realtimeCost(model, usage) {
  if (!usage) return 0;
  const p = model.includes('mini') ? RT_PRICES.mini : RT_PRICES.large;
  const inD = usage.input_token_details || {};
  const cached = inD.cached_tokens_details || {};
  const outD = usage.output_token_details || {};
  const textIn = Math.max(0, (inD.text_tokens || 0) - (cached.text_tokens || 0));
  const audioIn = Math.max(0, (inD.audio_tokens || 0) - (cached.audio_tokens || 0));
  return (
    textIn * p.textIn + (cached.text_tokens || 0) * p.textCached +
    audioIn * p.audioIn + (cached.audio_tokens || 0) * p.audioCached +
    (outD.text_tokens || 0) * p.textOut + (outD.audio_tokens || 0) * p.audioOut
  ) / 1e6;
}

function sessionConfig({ model, instructions, voice, speed, transcribeModel }) {
  return {
    type: 'realtime',
    model,
    instructions,
    audio: {
      input: {
        transcription: { model: transcribeModel, language: 'en' },
        noise_reduction: { type: 'near_field' },
        // "low": öğrenciye düşünmesi için zaman tanır, cümle ortasında kesmez
        turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true },
      },
      output: { voice, speed },
    },
  };
}

/**
 * Canlı Sohbet bağlantısı kurar.
 * opts: { apiKey, model, instructions, voice, speed, transcribeModel, stream, handlers }
 * handlers: onUserItem(itemId), onUserTranscript(itemId, text), onAssistantDelta(id, delta),
 *           onAssistantDone(id, text), onSpeaking(bool), onListening(bool), onUsage(usd), onError(msg), onOpen()
 */
export async function connectRealtime(opts) {
  const { apiKey, stream, handlers } = opts;
  const session = sessionConfig(opts);

  const pc = new RTCPeerConnection();
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.setAttribute('playsinline', '');
  pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };
  stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));

  const dc = pc.createDataChannel('oai-events');
  const send = (obj) => { if (dc.readyState === 'open') dc.send(JSON.stringify(obj)); };

  const assistantText = new Map();
  let closed = false;

  dc.addEventListener('open', () => {
    handlers.onOpen && handlers.onOpen();
  });

  dc.addEventListener('message', (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        handlers.onListening && handlers.onListening(true);
        break;
      case 'input_audio_buffer.speech_stopped':
        handlers.onListening && handlers.onListening(false);
        break;
      case 'input_audio_buffer.committed':
        handlers.onUserItem && handlers.onUserItem(ev.item_id);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        handlers.onUserTranscript && handlers.onUserTranscript(ev.item_id, (ev.transcript || '').trim());
        break;
      case 'conversation.item.input_audio_transcription.failed':
        handlers.onUserTranscript && handlers.onUserTranscript(ev.item_id, '');
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta': {
        const id = ev.response_id || ev.item_id;
        assistantText.set(id, (assistantText.get(id) || '') + (ev.delta || ''));
        handlers.onAssistantDelta && handlers.onAssistantDelta(id, ev.delta || '');
        break;
      }
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const id = ev.response_id || ev.item_id;
        handlers.onAssistantDone && handlers.onAssistantDone(id, ev.transcript || assistantText.get(id) || '');
        break;
      }
      case 'output_audio_buffer.started':
        handlers.onSpeaking && handlers.onSpeaking(true);
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        handlers.onSpeaking && handlers.onSpeaking(false);
        break;
      case 'response.done':
        if (ev.response?.usage) handlers.onUsage && handlers.onUsage(realtimeCost(opts.model, ev.response.usage));
        if (ev.response?.status === 'failed') {
          const msg = ev.response?.status_details?.error?.message || 'Cevap üretilemedi.';
          if (/quota|insufficient|billing|auth|key/i.test(msg)) handlers.onError && handlers.onError(msg);
          else handlers.onWarn && handlers.onWarn(msg);
        }
        break;
      case 'error':
        // Hatalar çoğunlukla önemsizdir (ör. iptal edilecek cevap yok); dersi durdurmaz
        if (ev.error && !/cancel|no active response/i.test(ev.error.message || '')) {
          console.warn('realtime error', ev.error);
          handlers.onWarn && handlers.onWarn(ev.error.message || 'Bilinmeyen hata');
        }
        break;
      default:
        break;
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    if (!closed && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
      handlers.onError && handlers.onError('Bağlantı koptu. İnternetini kontrol edip Devam Et’e bas.');
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Önce tam ayarlarla, reddedilirse en sade ayarlarla dene
  const minimal = {
    type: 'realtime',
    model: session.model,
    instructions: session.instructions,
    audio: { input: { transcription: { model: session.audio.input.transcription.model } }, output: { voice: session.audio.output.voice } },
  };
  let answerSdp = null;
  const errors = [];
  for (const cfg of [session, minimal]) {
    answerSdp = await tryConnect(apiKey, cfg, offer.sdp, errors);
    if (answerSdp) break;
    // Kimlik veya kota hatasıysa tekrar denemenin anlamı yok
    if (errors.some((e) => e.status === 401 || e.status === 429)) break;
  }
  if (!answerSdp) {
    pc.close();
    const e = errors.find((x) => x.status === 401 || x.status === 429) || errors[errors.length - 1] || {};
    if (e.status === 401) throw new Error('API anahtarı geçersiz (401).');
    if (e.status === 429) throw new Error('Kota veya kredi sorunu (429). Bakiyeni kontrol et.');
    throw new Error('Canlı Sohbet bağlantısı kurulamadı. ' + errors.map((x) => x.msg).join(' | ').slice(0, 300));
  }

  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  return {
    send,
    // Öğretmenin konuşmasını başlat (isteğe bağlı ek talimatla)
    respond(extra) {
      send(extra ? { type: 'response.create', response: { instructions: extra } } : { type: 'response.create' });
    },
    updateInstructions(instructions) {
      send({ type: 'session.update', session: { type: 'realtime', instructions } });
    },
    close() {
      closed = true;
      try { dc.close(); } catch { /* yok */ }
      try { pc.getSenders().forEach((s) => s.track && s.track.stop()); } catch { /* yok */ }
      try { pc.close(); } catch { /* yok */ }
      audioEl.srcObject = null;
    },
  };
}

// Bir ayar setiyle bağlanmayı dener: önce geçici anahtar, sonra birleşik arayüz
async function tryConnect(apiKey, session, sdp, errors) {
  try {
    const r = await fetch(BASE + '/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session }),
    });
    if (!r.ok) {
      errors.push({ status: r.status, msg: 'client_secrets ' + r.status + ': ' + (await r.text()).slice(0, 160) });
    } else {
      const j = await r.json();
      const ek = j.value || j.client_secret?.value;
      if (ek) {
        const s = await fetch(BASE + '/realtime/calls', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + ek, 'Content-Type': 'application/sdp' },
          body: sdp,
        });
        if (s.ok) return await s.text();
        errors.push({ status: s.status, msg: 'calls ' + s.status + ': ' + (await s.text()).slice(0, 160) });
      }
    }
  } catch (e) {
    errors.push({ status: 0, msg: e.message });
  }
  if (errors.some((e) => e.status === 401 || e.status === 429)) return null;
  try {
    const fd = new FormData();
    fd.set('sdp', sdp);
    fd.set('session', JSON.stringify(session));
    const s = await fetch(BASE + '/realtime/calls', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey }, body: fd });
    if (s.ok) return await s.text();
    errors.push({ status: s.status, msg: 'calls(form) ' + s.status + ': ' + (await s.text()).slice(0, 160) });
  } catch (e) {
    errors.push({ status: 0, msg: e.message });
  }
  return null;
}
