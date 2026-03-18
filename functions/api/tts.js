const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';
const ALICE_VOICE_ID = 'Xb7hH8MSUJpSbSDYk0k2';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function buildVoiceSettings(env) {
  const stability = Number(env.ELEVENLABS_STABILITY ?? 0.45);
  const similarityBoost = Number(env.ELEVENLABS_SIMILARITY_BOOST ?? 0.8);
  const useSpeakerBoost = String(env.ELEVENLABS_USE_SPEAKER_BOOST ?? 'true').toLowerCase() !== 'false';

  return {
    stability: Number.isFinite(stability) ? Math.min(1, Math.max(0, stability)) : 0.45,
    similarity_boost: Number.isFinite(similarityBoost) ? Math.min(1, Math.max(0, similarityBoost)) : 0.8,
    use_speaker_boost: useSpeakerBoost,
  };
}

function mapVoices(data) {
  const voices = Array.isArray(data?.voices) ? data.voices : [];
  return voices
    .map(voice => ({
      voiceId: voice.voice_id,
      name: voice.name,
      category: voice.category || '',
    }))
    .filter(voice => voice.voiceId && voice.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function filterFreeTierVoices(voices) {
  // ElevenLabs' free tier can use Default voices via API; these appear as "premade".
  return voices.filter(voice => voice.category === 'premade');
}

function resolveDefaultVoiceId(voices) {
  const alice = voices.find(voice => voice.voiceId === ALICE_VOICE_ID)
    || voices.find(voice => voice.name.toLowerCase().startsWith('alice'));
  return alice?.voiceId || voices[0]?.voiceId || '';
}

async function fetchVoices(apiKey) {
  const response = await fetch(`${ELEVENLABS_API_BASE}/voices`, {
    headers: {
      'xi-api-key': apiKey,
      'Accept': 'application/json',
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail?.message || data.detail || data.error || `Voice lookup failed (${response.status})`);
  }

  return mapVoices(data);
}

export async function onRequestGet(context) {
  const { env } = context;
  const apiKey = env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    return jsonResponse({
      configured: false,
      defaultVoiceId: '',
      voices: [],
      modelId: env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
      message: 'Set ELEVENLABS_API_KEY to enable ElevenLabs voices.',
    });
  }

  try {
    const voices = filterFreeTierVoices(await fetchVoices(apiKey));
    const defaultVoiceId = resolveDefaultVoiceId(voices);

    return jsonResponse({
      configured: true,
      defaultVoiceId,
      voices,
      modelId: env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
      voicePolicy: 'free-default-only',
    });
  } catch (err) {
    if (env.ELEVENLABS_VOICE_ID) {
      return jsonResponse({
        configured: true,
        defaultVoiceId: env.ELEVENLABS_VOICE_ID,
        voices: [],
        modelId: env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
        warning: err.message,
      });
    }

    return jsonResponse({
      configured: false,
      defaultVoiceId: '',
      voices: [],
      modelId: env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
      error: err.message,
    }, 502);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const apiKey = env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    return jsonResponse({ error: 'Missing ELEVENLABS_API_KEY.' }, 503);
  }

  try {
    const body = await request.json();
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const allowedVoices = filterFreeTierVoices(await fetchVoices(apiKey));
    const requestedVoiceId = body.voiceId || env.ELEVENLABS_VOICE_ID;
    const fallbackVoiceId = resolveDefaultVoiceId(allowedVoices);
    const voiceId = requestedVoiceId && allowedVoices.some(voice => voice.voiceId === requestedVoiceId)
      ? requestedVoiceId
      : fallbackVoiceId;

    if (!text) return jsonResponse({ error: 'Text is required.' }, 400);
    if (!voiceId) return jsonResponse({ error: 'No free-tier ElevenLabs voices are available for this API key.' }, 400);

    const response = await fetch(`${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
        output_format: env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128',
        voice_settings: buildVoiceSettings(env),
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return jsonResponse({
        error: errorData.detail?.message || errorData.detail || errorData.error || `ElevenLabs request failed (${response.status})`,
      }, response.status);
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  } catch (err) {
    return jsonResponse({ error: err.message || 'Unexpected TTS error.' }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
