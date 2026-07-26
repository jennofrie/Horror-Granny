/**
 * Horror audio — synthesized layers + a sample library (P7).
 *
 * Architecture: master gain → compressor; an SFX bus with a convolver
 * reverb send; continuous synth layers (room tone, fear drone, chase layer,
 * breath) driven per-frame from a fear param struct. P7 wires the downloaded
 * samples (public/assets/audio) through the same buses: one-shots → SFX bus
 * (so they boom in the reverb), music → master only (drier, sits under the
 * drone). Samples fetch at construction (menu time is dead time) and decode
 * once the AudioContext exists (start-click gesture). A one-shot fired
 * before its buffer is ready falls back to the synth version where one
 * exists, else is silently skipped.
 *
 * URLs are RELATIVE (`./assets/...`) on purpose — see gltf.ts (CG_EXPORT).
 */

export interface AudioParams {
  /** 0..1 composite dread level */
  fear: number;
  /** meters to entity (Infinity when dormant) */
  entityDist: number;
  /** -1..1 stereo direction of the entity relative to look dir */
  entityPan: number;
  chasing: boolean;
}

/** key -> filename in public/assets/audio (attribution: public/assets/audio/) */
const SAMPLE_URLS = {
  gunshot: "gunshot.ogg",
  growl: "monster-growl.ogg",
  heartbeat: "heartbeat.wav",
  stinger: "jumpscare-stinger.wav",
  music: "ambient-dark.mp3",
  step1: "footsteps-wood-1.ogg",
  step2: "footsteps-wood-2.ogg",
  step3: "footsteps-wood-3.ogg",
  swing1: "melee-swing-1.ogg",
  swing2: "melee-swing-2.ogg",
  impact1: "melee-impact-1.ogg",
  impact2: "melee-impact-2.ogg",
  doorCreak: "door-creak.ogg",
  wardrobeCreak: "wardrobe-creak.ogg",
  doorOpen: "door-open.ogg",
  pickup: "pickup.ogg",
} as const;
type SampleKey = keyof typeof SAMPLE_URLS;

/** music bed rest level — under the drone/room tone, ducked 50% in chase */
const MUSIC_BASE = 0.2;

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private wet!: GainNode;
  private noiseBuf!: AudioBuffer;

  private drone!: GainNode;
  private chaseLayer!: GainNode;
  private breathGain!: GainNode;

  // sample path: raw bytes fetch at construction, decode after init()
  private rawSamples = new Map<string, Promise<ArrayBuffer | null>>();
  private buffers = new Map<string, AudioBuffer | null>();
  private warned = new Set<string>();
  /** dev/verification: one-shots played per sample key */
  private played = new Map<string, number>();
  private rrStep = 0;
  private rrEntStep = 0;
  private rrSwing = 0;
  private rrImpact = 0;

  // sample-driven continuous layers (created lazily once decoded)
  private hbSrc: AudioBufferSourceNode | null = null;
  private hbGain: GainNode | null = null;
  private musicSrc: AudioBufferSourceNode | null = null;
  private musicGain: GainNode | null = null;

  private nextBeat = 0;
  private nextWhisper = 12;
  private params: AudioParams = {
    fear: 0,
    entityDist: Infinity,
    entityPan: 0,
    chasing: false,
  };

  constructor() {
    // Kick off downloads immediately; decoding waits for the AudioContext.
    for (const [key, file] of Object.entries(SAMPLE_URLS)) {
      this.rawSamples.set(
        key,
        fetch(`./assets/audio/${file}`)
          .then((r) => {
            if (!r.ok) throw new Error(`http ${r.status}`);
            return r.arrayBuffer();
          })
          .catch((err) => {
            this.warnSample(key, err);
            return null;
          }),
      );
    }
  }

  get ready(): boolean {
    return !!this.ctx;
  }

  /* ----------------------- dev / verification surface ----------------------- */

  get contextState(): string {
    return this.ctx?.state ?? "none";
  }

  /** sample keys whose buffers decoded successfully */
  get loadedSamples(): string[] {
    const out: string[] = [];
    for (const [k, b] of this.buffers) if (b) out.push(k);
    return out.sort();
  }

  /** one-shots actually played, per sample key (graph-state verification) */
  get playedCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, n] of this.played) out[k] = n;
    return out;
  }

  get musicPlaying(): boolean {
    return !!this.musicSrc;
  }

  get musicLevel(): number {
    return this.musicGain?.gain.value ?? 0;
  }

  get heartbeatLooping(): boolean {
    return !!this.hbSrc;
  }

  /* ------------------------------ lifecycle ------------------------------ */

  init() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 18;
    comp.ratio.value = 8;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // Reverb send — exponentially decaying noise impulse ≈ damp concrete space.
    const convolver = ctx.createConvolver();
    convolver.buffer = this.makeImpulse(1.6, 3.2);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.32;
    this.wet.connect(convolver);
    convolver.connect(this.master);

    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.sfx.connect(this.wet);

    this.noiseBuf = this.makeNoise(2);

    this.startRoomTone();
    this.startDrone();
    this.startBreath();
    this.decodeSamples();
  }

  async resume() {
    if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume();
  }
  async suspend() {
    if (this.ctx && this.ctx.state === "running") await this.ctx.suspend();
  }

  /* ------------------------------ sample path ------------------------------ */

  private warnSample(key: string, err: unknown) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`audio sample "${key}" unavailable:`, err);
  }

  /** Decode whatever fetched OK. Failures mark the key unavailable (null). */
  private decodeSamples() {
    const ctx = this.ctx!;
    for (const [key, p] of this.rawSamples) {
      void p.then((raw) => {
        if (!this.ctx) return;
        if (!raw) {
          this.buffers.set(key, null);
          return;
        }
        ctx.decodeAudioData(raw).then(
          (buf) => this.buffers.set(key, buf),
          (err) => {
            this.warnSample(key, err);
            this.buffers.set(key, null);
          },
        );
      });
    }
  }

  /**
   * Fire a sample one-shot through the SFX bus (reverb send included).
   * Returns the source, or null when the buffer isn't ready — callers fall
   * back to synth or skip. `wet: false` routes dry to master (not used by
   * one-shots today; music wires its own path).
   */
  private play(
    key: SampleKey,
    opts: { vol?: number; rate?: number; pan?: number } = {},
  ): AudioBufferSourceNode | null {
    const ctx = this.ctx;
    const buf = this.buffers.get(key);
    if (!ctx || !buf) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;
    const g = ctx.createGain();
    g.gain.value = opts.vol ?? 1;
    src.connect(g);
    if (opts.pan !== undefined) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, opts.pan));
      g.connect(p);
      p.connect(this.sfx);
    } else {
      g.connect(this.sfx);
    }
    src.start();
    this.played.set(key, (this.played.get(key) ?? 0) + 1);
    return src;
  }

  /* ------------------------- buffer helpers ------------------------- */

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  private noiseSource(loop = false): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = loop;
    return src;
  }

  /* ------------------------- ambient layers ------------------------- */

  private startRoomTone() {
    const ctx = this.ctx!;
    const src = this.noiseSource(true);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 180;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    src.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    src.start();

    // Slow swell so silence never feels safe.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.043;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.02;
    lfo.connect(lfoG);
    lfoG.connect(g.gain);
    lfo.start();
  }

  private startDrone() {
    const ctx = this.ctx!;
    this.drone = ctx.createGain();
    this.drone.gain.value = 0;
    this.drone.connect(this.master);
    this.drone.connect(this.wet);

    // Dissonant cluster — minor second + tritone intervals, slowly beating.
    for (const [freq, g] of [[55, 0.5], [56.7, 0.4], [82.4, 0.2], [110.6, 0.12], [164.2, 0.07]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const og = ctx.createGain();
      og.gain.value = g * 0.4;
      osc.connect(og);
      og.connect(this.drone);
      osc.start();
    }

    // Chase layer: harsher, pulsing.
    this.chaseLayer = ctx.createGain();
    this.chaseLayer.gain.value = 0;
    this.chaseLayer.connect(this.master);
    const saw = ctx.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.value = 41.2;
    const sawLp = ctx.createBiquadFilter();
    sawLp.type = "lowpass";
    sawLp.frequency.value = 320;
    const trem = ctx.createOscillator();
    trem.frequency.value = 7.3;
    const tremG = ctx.createGain();
    tremG.gain.value = 0.5;
    const tremBase = ctx.createGain();
    tremBase.gain.value = 0.55;
    saw.connect(sawLp);
    sawLp.connect(tremBase);
    trem.connect(tremG);
    tremG.connect(tremBase.gain);
    tremBase.connect(this.chaseLayer);
    saw.start();
    trem.start();
  }

  private startBreath() {
    const ctx = this.ctx!;
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;
    const src = this.noiseSource(true);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 600;
    bp.Q.value = 0.7;
    // breath rhythm
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.45;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.5;
    const base = ctx.createGain();
    base.gain.value = 0.5;
    src.connect(bp);
    bp.connect(base);
    lfo.connect(lfoG);
    lfoG.connect(base.gain);
    base.connect(this.breathGain);
    this.breathGain.connect(this.master);
    src.start();
    lfo.start();
  }

  /* --------------------------- per-frame --------------------------- */

  setParams(p: AudioParams) {
    this.params = p;
  }

  update(dt: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const p = this.params;

    const ramp = (param: AudioParam, v: number, tc = 0.25) =>
      param.setTargetAtTime(v, t, tc);

    ramp(this.drone.gain, p.fear * 0.34, 0.8);
    ramp(this.chaseLayer.gain, p.chasing ? 0.16 : 0, p.chasing ? 0.15 : 1.2);
    ramp(this.breathGain.gain, Math.max(0, p.fear - 0.45) * 0.1, 0.6);

    // Ambient music bed (P7) — starts once decoded, gentle fade-in, ducked
    // ~50% while the chase layer owns the mix.
    if (!this.musicSrc) {
      const buf = this.buffers.get("music");
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        this.musicGain = ctx.createGain();
        this.musicGain.gain.value = 0;
        src.connect(this.musicGain);
        this.musicGain.connect(this.master); // dry — under the drone, no reverb wash
        src.start();
        this.musicSrc = src;
        this.musicGain.gain.setTargetAtTime(MUSIC_BASE, t, 1.8); // slow fade-in
      }
    } else if (this.musicGain) {
      ramp(this.musicGain.gain, MUSIC_BASE * (p.chasing ? 0.5 : 1), p.chasing ? 0.4 : 1.5);
    }

    // Heartbeat (P7): the sample loops, rate/gain driven by the old fear
    // logic — playbackRate 0.8–1.4 across the fear range. Until the buffer
    // lands (or if it failed) the synth per-beat scheduler covers.
    if (!this.hbSrc) {
      const buf = this.buffers.get("heartbeat");
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.playbackRate.value = 0.8;
        this.hbGain = ctx.createGain();
        this.hbGain.gain.value = 0;
        src.connect(this.hbGain);
        this.hbGain.connect(this.master);
        src.start();
        this.hbSrc = src;
      }
    }
    if (this.hbSrc && this.hbGain) {
      ramp(this.hbSrc.playbackRate, 0.8 + p.fear * 0.6, 0.4);
      const vol = p.fear > 0.18 ? Math.min(1, (p.fear - 0.15) * 1.3) * 0.5 : 0;
      ramp(this.hbGain.gain, vol, 0.3);
    } else if (p.fear > 0.18) {
      // Synth fallback: per-beat scheduling.
      if (t >= this.nextBeat) {
        const rate = 0.95 + p.fear * 1.25; // Hz
        this.heartbeat(Math.min(1, (p.fear - 0.15) * 1.3));
        this.nextBeat = t + 1 / rate;
      }
    } else {
      this.nextBeat = Math.max(this.nextBeat, t + 0.5);
    }

    // Occasional whisper from the walls when dread is mid-high.
    this.nextWhisper -= dt;
    if (this.nextWhisper <= 0) {
      if (p.fear > 0.25 && p.fear < 0.85 && Math.random() < 0.6) this.whisper();
      this.nextWhisper = 9 + Math.random() * 16;
    }
  }

  /* ----------------------------- one-shots ----------------------------- */

  /** Synth heartbeat — fallback until heartbeat.wav is decoded. */
  private heartbeat(vol: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const beat = (at: number, gain: number) => {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(52, at);
      osc.frequency.exponentialRampToValueAtTime(30, at + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(gain, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(g);
      g.connect(this.master);
      osc.start(at);
      osc.stop(at + 0.2);
    };
    beat(t, 0.34 * vol);
    beat(t + 0.14, 0.2 * vol);
  }

  playerStep(sprinting: boolean) {
    if (!this.ctx) return;
    const vol = sprinting ? 0.17 : 0.1;

    // P7: real wood steps, round-robin with pitch/gain jitter so the loop
    // never machines-guns. Sneak stays silent at the player.ts level.
    const keys: SampleKey[] = ["step1", "step2", "step3"];
    const key = keys[this.rrStep++ % keys.length];
    const jitter = 0.88 + Math.random() * 0.24;
    if (this.play(key, { vol: vol * 2.2 * jitter, rate: 0.94 + Math.random() * 0.12 })) return;

    // Synth fallback (carpet scuff + weight thump) until samples land.
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = this.noiseSource();
    src.playbackRate.value = 0.7 + Math.random() * 0.5;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 700 + Math.random() * 500;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + 0.12);

    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(82, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.07);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol * 0.8, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(og);
    og.connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  entityStep(dist: number, pan: number, slug = "grandma") {
    if (!this.ctx || dist > 30) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const vol = Math.min(0.5, 6 / (dist + 2));

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(this.sfx);

    // Positional synth thump stays — it carries the weight.
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(58, t);
    osc.frequency.exponentialRampToValueAtTime(26, t + 0.16);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(og);
    og.connect(panner);
    osc.start(t);
    osc.stop(t + 0.25);

    // P7: per-tier character layered on top — same wood steps the player
    // makes, pitched per hunter: grandma shuffles, the devil stomps.
    const keys: SampleKey[] = ["step1", "step2", "step3"];
    const key = keys[this.rrEntStep++ % keys.length];
    const baseRate = slug === "devil" ? 0.72 : slug === "grandpa" ? 0.88 : 1.02;
    const tierGain = slug === "devil" ? 1.0 : slug === "grandpa" ? 0.7 : 0.55;
    this.play(key, {
      vol: Math.min(0.5, vol * 1.5 * tierGain),
      rate: baseRate * (0.96 + Math.random() * 0.08),
      pan,
    });
  }

  whisper() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 1.2 + Math.random() * 1.6;

    const src = this.noiseSource();
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(900 + Math.random() * 700, t);
    bp.Q.value = 6;
    // formant wobble — makes noise feel like speech just below intelligibility
    const wob = ctx.createOscillator();
    wob.frequency.value = 2.6 + Math.random() * 3;
    const wobG = ctx.createGain();
    wobG.gain.value = 420;
    wob.connect(wobG);
    wobG.connect(bp.frequency);

    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.035, t + dur * 0.4);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(pan);
    pan.connect(this.wet);
    src.start(t, Math.random());
    src.stop(t + dur + 0.1);
    wob.start(t);
    wob.stop(t + dur + 0.1);
  }

  /**
   * Entity chase screech — THE scare. P7: monster-growl sample carries it,
   * pitched per tier (grandma up, grandpa/devil down, ±10% jitter). The
   * synth screech stays layered UNDER the growl for the devil at reduced
   * gain, and remains the full fallback while the growl is undecoded.
   */
  screech(slug = "devil") {
    if (!this.ctx) return;
    const baseRate = slug === "grandma" ? 1.1 : slug === "grandpa" ? 0.9 : 0.85;
    const growled = this.play("growl", {
      vol: 0.85,
      rate: baseRate * (0.95 + Math.random() * 0.1),
    });
    if (growled && slug !== "devil") return;
    this.synthScreech(growled ? 0.55 : 1);
  }

  /** The original synth screech; `scale` drops it under the growl sample. */
  private synthScreech(scale = 1) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;

    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1;
      curve[i] = Math.tanh(x * 4);
    }
    shaper.curve = curve;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.55 * scale, t + 0.06);
    sg.gain.setValueAtTime(0.55 * scale, t + 0.7);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
    shaper.connect(sg);
    sg.connect(this.master);
    sg.connect(this.wet);

    for (const ratio of [1, 1.93, 2.41]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(420 * ratio, t);
      osc.frequency.exponentialRampToValueAtTime(1750 * ratio, t + 0.55);
      osc.frequency.exponentialRampToValueAtTime(900 * ratio, t + 1.6);
      // vibrato panic
      const vib = ctx.createOscillator();
      vib.frequency.value = 23;
      const vibG = ctx.createGain();
      vibG.gain.value = 60 * ratio;
      vib.connect(vibG);
      vibG.connect(osc.frequency);
      const og = ctx.createGain();
      og.gain.value = ratio === 1 ? 0.5 : 0.2;
      osc.connect(og);
      og.connect(shaper);
      osc.start(t);
      osc.stop(t + 2);
      vib.start(t);
      vib.stop(t + 2);
    }

    // Noise blast + sub drop.
    const src = this.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2600;
    bp.Q.value = 0.5;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.3 * scale, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 1.2);

    const sub = ctx.createOscillator();
    sub.frequency.setValueAtTime(64, t);
    sub.frequency.exponentialRampToValueAtTime(24, t + 1.3);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.5 * scale, t);
    subG.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    sub.connect(subG);
    subG.connect(this.master);
    sub.start(t);
    sub.stop(t + 1.5);
  }

  /** P7: handgun shot — big, through the SFX bus so it booms in the house. */
  gunshot() {
    if (!this.ctx) return;
    // No synth fallback by design: a shot before the buffer lands is silence.
    this.play("gunshot", { vol: 0.9, rate: 0.97 + Math.random() * 0.06 });
  }

  /** P7: melee whoosh, alternating samples. */
  meleeSwing() {
    if (!this.ctx) return;
    const key: SampleKey = this.rrSwing++ % 2 === 0 ? "swing1" : "swing2";
    this.play(key, { vol: 0.55, rate: 0.94 + Math.random() * 0.12 });
  }

  /** P7: melee hit connect, alternating samples. */
  meleeImpact() {
    if (!this.ctx) return;
    const key: SampleKey = this.rrImpact++ % 2 === 0 ? "impact1" : "impact2";
    this.play(key, { vol: 0.7, rate: 0.94 + Math.random() * 0.12 });
  }

  /** P7: jumpscare sting — death hit + the "something stirs" tier spawn. */
  stinger(vol = 0.8) {
    if (!this.ctx) return;
    this.play("stinger", { vol, rate: 0.98 + Math.random() * 0.04 });
  }

  /** P7: the exit door giving way. */
  doorOpen() {
    if (!this.ctx) return;
    this.play("doorOpen", { vol: 0.8 });
  }

  /** P7: item pickup — sample, with the old click as fallback. */
  pickup() {
    if (!this.ctx) return;
    if (this.play("pickup", { vol: 0.7 })) return;
    this.click();
  }

  /** Flashlight switch — dry mechanical click. */
  click() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = this.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 3100;
    bp.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + 0.05);
  }

  /** P5/P7: wood creak — climbing into / out of a wardrobe or under a bed. */
  creak(kind: "wardrobe" | "under-bed" = "wardrobe") {
    if (!this.ctx) return;
    const key: SampleKey = kind === "under-bed" ? "doorCreak" : "wardrobeCreak";
    if (this.play(key, { vol: 0.6, rate: 0.94 + Math.random() * 0.12 })) return;

    // Synth fallback (stuttering hinge).
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(150 + Math.random() * 50, t);
    osc.frequency.linearRampToValueAtTime(88, t + 0.34);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 470;
    bp.Q.value = 7;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 10.5;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 95;
    lfo.connect(lfoG);
    lfoG.connect(bp.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.085, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(bp);
    bp.connect(g);
    g.connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.5);
    lfo.start(t);
    lfo.stop(t + 0.5);
  }

  /** P5/P7: the enemy yanking a wardrobe open / peering under a bed. */
  spotCheck(dist: number, pan: number, kind: "wardrobe" | "under-bed" = "wardrobe") {
    if (!this.ctx || dist > 30) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const vol = Math.min(0.6, 7 / (dist + 2));

    // P7: real furniture creak, positional.
    const key: SampleKey = kind === "under-bed" ? "doorCreak" : "wardrobeCreak";
    const sampled = this.play(key, {
      vol: vol * 1.1,
      rate: 0.9 + Math.random() * 0.15,
      pan,
    });

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(this.sfx);

    if (!sampled) {
      // Synth fallback: wood groan as the furniture is worked open.
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(92, t);
      osc.frequency.linearRampToValueAtTime(150, t + 0.26);
      osc.frequency.linearRampToValueAtTime(68, t + 0.6);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 380;
      bp.Q.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.13 * vol, t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      osc.connect(bp);
      bp.connect(g);
      g.connect(panner);
      osc.start(t);
      osc.stop(t + 0.75);
    }

    // weight thud — a heavy body leaning on the frame (kept: sells the mass)
    const th = ctx.createOscillator();
    th.frequency.setValueAtTime(70, t + 0.1);
    th.frequency.exponentialRampToValueAtTime(34, t + 0.32);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, t + 0.1);
    tg.gain.linearRampToValueAtTime(0.2 * vol, t + 0.14);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    th.connect(tg);
    tg.connect(panner);
    th.start(t + 0.1);
    th.stop(t + 0.45);
  }

  /** Fluorescent fixture dying nearby. */
  zap() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = this.noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + 0.1);

    const ping = ctx.createOscillator();
    ping.frequency.setValueAtTime(2300, t);
    ping.frequency.exponentialRampToValueAtTime(640, t + 0.4);
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0.05, t);
    pg.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    ping.connect(pg);
    pg.connect(this.sfx);
    ping.start(t);
    ping.stop(t + 0.5);
  }

  /** A dead fixture somewhere down the maze arcs back to life — go look. */
  buzz() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // mains hum swelling in — routed through the reverb only, so it sits
    // "somewhere out there" instead of in your ear
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 119;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 850;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.05, t + 0.7);
    og.gain.setValueAtTime(0.05, t + 2.4);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
    osc.connect(lp);
    lp.connect(og);
    og.connect(this.wet);
    osc.start(t);
    osc.stop(t + 3.7);

    // arc strikes
    for (let i = 0; i < 5; i++) {
      const at = t + 0.15 + Math.random() * 2.6;
      const src = this.noiseSource();
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2200 + Math.random() * 2000;
      bp.Q.value = 3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.05, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.wet);
      src.start(at, Math.random());
      src.stop(at + 0.07);
    }
  }

  death(slug = "devil") {
    if (!this.ctx) return;
    // P7: the jumpscare sting hits first, the killer's voice under it.
    this.stinger(0.9);
    this.screech(slug);
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Everything collapses into a sub rumble.
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0.0, t + 2.6);
  }

  win() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const [f, g0, at] of [[220, 0.07, 0], [277.2, 0.05, 0.3], [329.6, 0.05, 0.6], [440, 0.03, 0.9]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + at);
      g.gain.linearRampToValueAtTime(g0, t + at + 0.4);
      g.gain.linearRampToValueAtTime(0, t + at + 4);
      osc.connect(g);
      g.connect(this.master);
      g.connect(this.wet);
      osc.start(t + at);
      osc.stop(t + at + 4.2);
    }
    this.drone.gain.setTargetAtTime(0, t, 0.4);
    this.chaseLayer.gain.setTargetAtTime(0, t, 0.2);
    this.musicGain?.gain.setTargetAtTime(MUSIC_BASE * 0.5, t, 1.2);
  }

  dispose() {
    this.ctx?.close();
    this.ctx = null;
  }
}
