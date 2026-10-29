const BrowserAudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
const PREFIX = "aws-warrior:v2:sound-";
const EFFECTS = {
  step: [[700, 0.07, 0, 0.12, "noise", 150]],
  swing: [[3000, 0.16, 0, 0.22, "noise", 450]],
  hit: [[1400, 0.08, 0, 0.3, "noise", 150], [90, 0.1, 0, 0.14, "triangle", 50]],
  hurt: [[180, 0.2, 0, 0.12, "sawtooth", 65]],
  death: [[140, 0.45, 0, 0.2, "triangle", 35], [220, 0.2, 0, 0.12, "noise", 80]],
  quest: [[523, 0.14, 0, 0.16], [659, 0.2, 0.12, 0.16]],
  success: [[523, 0.16, 0, 0.16], [659, 0.16, 0.14, 0.16], [784, 0.3, 0.28, 0.16]],
  failure: [[220, 0.18, 0, 0.16, "triangle", 180], [146, 0.26, 0.17, 0.16, "triangle", 110]],
  axe: [[900, 0.24, 0, 0.2, "noise", 120], [100, 0.15, 0.03, 0.13, "triangle", 45]],
  punch: [[450, 0.09, 0, 0.16, "noise", 100]],
  dodge: [[1900, 0.18, 0, 0.12, "noise", 300]],
  evade: [[880, 0.08, 0, 0.09, "sine", 1320]],
  equip: [[440, 0.06, 0, 0.08, "triangle", 660], [880, 0.08, 0.05, 0.07]],
  yeti: [[80, 0.5, 0, 0.12, "sawtooth", 45], [350, 0.4, 0, 0.12, "noise", 90]],
  slam: [[65, 0.3, 0, 0.2, "triangle", 28], [650, 0.22, 0, 0.17, "noise", 70]],
  cactus: [[1600, 0.09, 0, 0.07, "noise", 700], [1800, 0.09, 0.14, 0.07, "noise", 800]],
  spike: [[1500, 0.13, 0, 0.11, "triangle", 450], [2200, 0.1, 0, 0.09, "noise", 900]],
  bat: [[1800, 0.12, 0, 0.07, "sawtooth", 900], [2200, 0.1, 0.1, 0.06, "sine", 1400]],
  portal: [[220, 0.45, 0, 0.1, "sine", 880], [330, 0.4, 0.12, 0.08, "triangle", 1320]],
  chest: [[392, 0.12, 0, 0.1], [587, 0.15, 0.1, 0.1], [784, 0.25, 0.22, 0.12]],
  revive: [[262, 0.18, 0, 0.1], [392, 0.2, 0.15, 0.1], [523, 0.3, 0.3, 0.1]],
  hammer: [[500, 0.24, 0, 0.16, "noise", 70], [75, 0.2, 0.04, 0.16, "triangle", 35]],
  block: [[1800, 0.16, 0, 0.13, "square", 700], [3200, 0.09, 0, 0.09, "noise", 900]],
  guardBreak: [[2200, 0.28, 0, 0.16, "noise", 160], [120, 0.3, 0, 0.15, "sawtooth", 40]],
  magicLightning: [[2400, 0.18, 0, 0.15, "noise", 200], [880, 0.2, 0, 0.1, "sawtooth", 180]],
  magicFire: [[200, 0.45, 0, 0.18, "noise", 1200], [90, 0.3, 0.1, 0.12, "triangle", 35]],
  magicFrost: [[2500, 0.5, 0, 0.12, "noise", 700], [1200, 0.4, 0, 0.08, "sine", 1800]],
  magicStorm: [[80, 0.65, 0, 0.18, "noise", 500], [160, 0.5, 0.1, 0.12, "sawtooth", 40]],
  magicShock: [[140, 0.45, 0, 0.18, "triangle", 25], [900, 0.3, 0, 0.12, "noise", 80]],
};
const COOLDOWNS = { yeti: 0.6, bat: 0.35, cactus: 0.3, spike: 0.12, slam: 0.15,
  equip: 0.08, evade: 0.12, block: 0.1, guardBreak: 0.2 };
const MALE_VOICE_PATTERN = /\b(male|man|wanlung|wan\s*lung|aasing|aa\s*sing|danny|kangkang|yunxi|yunjian|yunyang)\b|男|雲龍|云龙|阿成/i;
const FEMALE_VOICE_PATTERN = /\b(female|woman|girl|hiumaan|hiugaai|sin[-\s]?ji|ting[-\s]?ting|mei[-\s]?jia)\b|女|曉曼|曉佳/i;

export function isMaleVoice(voice) {
  const label = `${voice?.name || ""} ${voice?.voiceURI || ""}`;
  return MALE_VOICE_PATTERN.test(label) && !FEMALE_VOICE_PATTERN.test(label);
}

export class SoundEffects {
  constructor({ storage = globalThis.localStorage,
    synthesis = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance,
    createContext = BrowserAudioContext ? () => new BrowserAudioContext() : null } = {}) {
    this.synthesis = synthesis;
    this.Utterance = Utterance;
    this.speechUnlocked = false;
    this.storage = storage;
    this.createContext = createContext;
    this.available = typeof createContext === "function";
    this.context = null;
    this.master = null;
    this.resuming = null;
    this.pending = [];
    this.muted = this.read("muted") === "true";
    this.voiceURI = this.read("voice") || "";
    const savedVolume = this.read("volume");
    const volume = savedVolume === null ? 0.45 : Number(savedVolume);
    this.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.45;
    this.paused = false;
    this.distance = 0;
    this.lastPlayed = new Map();
  }

  read(key) {
    try { return this.storage?.getItem(PREFIX + key) ?? null; } catch { return null; }
  }

  save(key, value) {
    try { this.storage?.setItem(PREFIX + key, String(value)); } catch { /* Audio works without storage. */ }
  }

  async unlock() {
    this.unlockSpeech();
    if (!this.available || this.muted || this.volume === 0) return false;
    if (!this.context) {
      try {
        this.context = this.createContext();
        this.master = this.context.createGain();
        this.master.connect(this.context.destination);
        this.master.gain.value = this.paused ? 0 : this.volume;
      } catch {
        this.available = false;
        return false;
      }
    }
    try {
      if (this.context.state === "suspended") {
        if (!this.resuming) {
          this.resuming = this.context.resume().then(() => {
            const pending = this.pending.splice(0);
            for (const [effect, distance] of pending) this.play(effect, distance);
          }).finally(() => { this.resuming = null; });
        }
        await this.resuming;
      }
      return this.context.state === "running";
    } catch { this.pending = []; return false; }
  }

  updateGain() {
    if (this.muted || this.paused || this.volume === 0) this.stopSpeech();
    if (this.master) {
      this.master.gain.setTargetAtTime(this.muted || this.paused ? 0 : this.volume, this.context.currentTime, 0.01);
    }
  }

  stopSpeech() {
    try { this.synthesis?.cancel(); } catch { /* Speech must never interrupt combat. */ }
    this.utterance = null;
  }

  unlockSpeech() {
    if (this.speechUnlocked || !this.synthesis || !this.Utterance ||
        this.muted || this.paused || !this.volume) return;
    try {
      const utterance = new this.Utterance(" ");
      utterance.volume = 0;
      utterance.lang = "zh-HK";
      this.synthesis.speak(utterance);
      this.speechUnlocked = true;
    } catch { /* Unsupported speech remains optional. */ }
  }

  speakAttack(name) {
    if (!this.synthesis || !this.Utterance || this.muted || this.paused || !this.volume) return false;
    try {
      this.stopSpeech();
      const utterance = new this.Utterance(name.replace(/・/g, "，"));
      const cantonese = this.cantoneseVoices();
      const maleVoice = cantonese.find(isMaleVoice);
      utterance.voice = cantonese.find(voice => voice.voiceURI === this.voiceURI) ||
        maleVoice || cantonese.find(voice => voice.localService) || cantonese[0] || null;
      utterance.lang = utterance.voice?.lang || "zh-HK";
      utterance.volume = this.volume;
      utterance.rate = 0.92;
      utterance.pitch = isMaleVoice(utterance.voice) ? 0.88 : 0.65;
      this.utterance = utterance;
      this.synthesis.speak(utterance);
      return true;
    } catch { return false; }
  }

  cantoneseVoices() {
    try {
      return (this.synthesis?.getVoices() || []).filter(voice =>
        /^(zh[-_]HK|yue)(?:[-_]|$)/i.test(voice.lang));
    } catch { return []; }
  }

  selectVoice(uri) {
    if (uri && !this.cantoneseVoices().some(voice => voice.voiceURI === uri)) return false;
    this.stopSpeech();
    this.voiceURI = uri;
    this.save("voice", uri);
    return true;
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.muted) this.pending = [];
    this.save("muted", this.muted);
    this.updateGain();
  }

  setVolume(volume) {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.max(0, Math.min(1, volume));
    this.save("volume", this.volume);
    this.updateGain();
  }

  setPaused(paused) {
    this.paused = paused;
    if (paused) this.pending = [];
    this.distance = 0;
    this.updateGain();
  }

  step(distance, running = false) {
    if (!Number.isFinite(distance) || distance < 0.001 || distance > 8) {
      this.distance = 0;
      return;
    }
    this.distance += distance;
    const stride = running ? 3 : 2;
    if (this.distance >= stride) {
      this.distance %= stride;
      this.play("step");
    }
  }

  play(effect, distance = 0) {
    const notes = EFFECTS[effect];
    if (!notes || this.muted || this.paused || this.volume === 0 ||
        !Number.isFinite(distance) || distance < 0 || distance >= 60) return false;
    if (this.context?.state !== "running") {
      if (this.resuming && this.context.state === "suspended" && this.pending.length < 8) {
        this.pending.push([effect, distance]);
        return true;
      }
      return false;
    }
    const now = this.context.currentTime;
    if (now - (this.lastPlayed.get(effect) ?? -Infinity) < (COOLDOWNS[effect] || 0)) return false;
    this.lastPlayed.set(effect, now);
    const attenuation = 1 - distance / 60;
    for (const note of notes) this.voice(note, attenuation);
    return true;
  }

  voice([frequency, duration, delay, volume, type = "sine", end = frequency], attenuation = 1) {
    const context = this.context;
    const start = context.currentTime + delay;
    const gain = context.createGain();
    let source, filter;
    if (type === "noise") {
      source = context.createBufferSource();
      const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
      source.buffer = buffer;
      filter = context.createBiquadFilter();
      filter.type = "lowpass";
      source.connect(filter);
      filter.connect(gain);
    } else {
      source = context.createOscillator();
      source.type = type;
      source.connect(gain);
    }
    const pitch = filter ? filter.frequency : source.frequency;
    pitch.setValueAtTime(frequency, start);
    pitch.exponentialRampToValueAtTime(end, start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume * attenuation, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    gain.connect(this.master);
    source.onended = () => {
      source.disconnect();
      filter?.disconnect();
      gain.disconnect();
    };
    source.start(start);
    source.stop(start + duration);
  }
}
