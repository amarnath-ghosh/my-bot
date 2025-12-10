export interface SpeechConfig {
  rate?: number;
  pitch?: number;
  volume?: number;
  voice?: string; // Model name, e.g., "aura-asteria-en"
}

export interface VoiceInfo {
  name: string;
  lang: string;
  gender: 'male' | 'female' | 'unknown';
  isDefault: boolean;
}

export class SpeechService {
  private synth: SpeechSynthesis | any;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private config: Required<SpeechConfig>;
  private availableVoices: SpeechSynthesisVoice[] = [];
  private deepgramApiKey: string | undefined;

  constructor(config: SpeechConfig = {}) {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      this.synth = window.speechSynthesis;
    } else {
      // Mock for Node.js
      this.synth = {
        getVoices: () => [],
        cancel: () => { },
        pause: () => { },
        resume: () => { },
        speak: () => { },
        onvoiceschanged: null,
        speaking: false,
        paused: false,
      };
    }

    this.config = {
      rate: 1.0,
      pitch: 1.0,
      volume: 1.0,
      voice: 'aura-asteria-en', // Default to a Deepgram Aura voice
      ...config,
    };

    this.deepgramApiKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY;

    this.initializeVoices();
  }

  private initializeVoices(): void {
    if (typeof window === 'undefined') return;

    // This is for local speech
    const updateVoices = () => {
      this.availableVoices = this.synth.getVoices();
    };

    updateVoices();

    // Listen for voices changed event (some browsers need this)
    if (this.synth.onvoiceschanged !== undefined) {
      this.synth.onvoiceschanged = updateVoices;
    }
  }

  getAvailableVoices(): VoiceInfo[] {
    return this.availableVoices.map(voice => ({
      name: voice.name,
      lang: voice.lang,
      gender: this.determineGender(voice.name.toLowerCase()),
      isDefault: voice.default,
    }));
  }

  private determineGender(voiceName: string): 'male' | 'female' | 'unknown' {
    const femaleIndicators = [
      'female', 'woman', 'girl', 'lady', 'samantha', 'susan', 'karen', 'anna', 'emma',
    ];
    const maleIndicators = [
      'male', 'man', 'boy', 'gentleman', 'daniel', 'alex', 'tom', 'david', 'james',
    ];

    const lowerName = voiceName.toLowerCase();

    if (femaleIndicators.some(indicator => lowerName.includes(indicator))) {
      return 'female';
    }
    if (maleIndicators.some(indicator => lowerName.includes(indicator))) {
      return 'male';
    }

    return 'unknown';
  }

  /**
   * Speaks audio LOCALLY for the user to hear.
   * This audio does NOT go to the meeting.
   */
  async speak(
    text: string,
    onEnd?: () => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    if (typeof window === 'undefined') {
      console.warn('Local speech not supported in Node.js environment');
      if (onEnd) onEnd();
      return;
    }

    return new Promise((resolve, reject) => {
      // Cancel any ongoing speech
      this.stop();

      this.currentUtterance = new SpeechSynthesisUtterance(text);
      this.currentUtterance.rate = this.config.rate;
      this.currentUtterance.pitch = this.config.pitch;
      this.currentUtterance.volume = this.config.volume;

      // Set voice if specified
      if (this.config.voice) {
        const selectedVoice = this.availableVoices.find(
          voice =>
            voice.name === this.config.voice ||
            voice.lang.includes(this.config.voice)
        );
        if (selectedVoice) {
          this.currentUtterance.voice = selectedVoice;
        }
      }

      this.currentUtterance.onend = () => {
        if (onEnd) onEnd();
        resolve();
      };

      this.currentUtterance.onerror = (event: any) => {
        const error = new Error(`Speech synthesis error: ${event.error}`);
        if (onError) onError(error);
        reject(error);
      };

      this.synth.speak(this.currentUtterance);
    });
  }

  stop(): void {
    this.synth.cancel();
    this.currentUtterance = null;
  }

  pause(): void {
    if (this.synth.speaking) {
      this.synth.pause();
    }
  }

  resume(): void {
    if (this.synth.paused) {
      this.synth.resume();
    }
  }

  isSpeaking(): boolean {
    return this.synth.speaking;
  }

  isPaused(): boolean {
    return this.synth.paused;
  }

  updateConfig(newConfig: Partial<SpeechConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Creates an ArrayBuffer of the bot's speech (RAW PCM DATA).
   * This audio data is intended to be sent TO THE MEETING.
   */
  async createAudioData(text: string): Promise<ArrayBuffer> {
    if (!this.deepgramApiKey || this.deepgramApiKey === "YOUR_DEEPGRAM_API_KEY_HERE") {
      console.error('Deepgram API key is not set. Cannot generate bot speech.');
      throw new Error('Deepgram API key is not set.');
    }

    const model = this.config.voice || 'aura-asteria-en';

    const params = new URLSearchParams({
      model: model,
      encoding: 'linear16',    // Request 16-bit linear PCM
      sample_rate: '24000',    // This is the sample rate our content-script context will use
      // --- NO CONTAINER (WAV) ---
    });

    const url = `https://api.deepgram.com/v1/speak?${params.toString()}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Token ${this.deepgramApiKey}`,
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(`Deepgram TTS API error: ${err.reason || response.statusText}`);
      }

      // Return the raw audio data as an ArrayBuffer
      return await response.arrayBuffer();

    } catch (error) {
      console.error('Error generating bot audio data:', error);
      throw error;
    }
  }
}