import { AudioCaptureSettings } from './types';

export interface AudioTrackInfo {
  track: MediaStreamTrack;
  type: 'original' | 'synthetic';
  created: number;
}

export class AudioManager {
  private peerConnection: RTCPeerConnection | null = null;
  private originalTrack: MediaStreamTrack | null = null;
  private syntheticTrack: MediaStreamTrack | null = null;
  private currentSender: RTCRtpSender | null = null;
  private audioSwapLock = false;
  private trackHistory: AudioTrackInfo[] = [];

  constructor(pc?: RTCPeerConnection) {
    this.peerConnection = pc || null;
  }

  setPeerConnection(pc: RTCPeerConnection): void {
    this.peerConnection = pc;
  }

  async initializeOriginalTrack(settings: AudioCaptureSettings): Promise<MediaStreamTrack> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: settings.sampleRate,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl
        }
      });

      const audioTrack = stream.getAudioTracks()[0];
      this.originalTrack = audioTrack;
      
      this.trackHistory.push({
        track: audioTrack,
        type: 'original',
        created: Date.now()
      });

      return audioTrack;
    } catch (error) {
      throw new Error(`Failed to initialize original audio track: ${error}`);
    }
  }

  async captureSystemAudio(sourceId?: string): Promise<MediaStream> {
    try {
      const constraints: MediaStreamConstraints = {
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
          }
        } as any,
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
          }
        } as any
      };

      // Fallback to getDisplayMedia if desktop capture fails
      try {
        return await (navigator.mediaDevices as any).getUserMedia(constraints);
      } catch {
        return await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        });
      }
    } catch (error) {
      throw new Error(`Failed to capture system audio: ${error}`);
    }
  }

  async saveCurrentAudioSender(): Promise<void> {
    if (!this.peerConnection) {
      throw new Error('PeerConnection not available. Cannot find audio sender.');
    }

    if (this.peerConnection.connectionState === 'closed' || this.peerConnection.connectionState === 'failed') {
      throw new Error(`PeerConnection invalid state: ${this.peerConnection.connectionState}`);
    }

    const senders = this.peerConnection.getSenders();
    const audioSender = senders.find(sender => sender.track?.kind === 'audio');

    if (audioSender && audioSender.track) {
      this.currentSender = audioSender;
      if (!this.originalTrack) {
        this.originalTrack = audioSender.track;
        this.trackHistory.push({
          track: audioSender.track,
          type: 'original',
          created: Date.now()
        });
      }
    } else {
      throw new Error('No audio sender found in peer connection');
    }
  }

  async replaceWithSynthetic(syntheticTrack: MediaStreamTrack): Promise<void> {
    if (!this.peerConnection) {
      throw new Error('PeerConnection not available');
    }

    // Prevent concurrent swaps
    if (this.audioSwapLock) {
      throw new Error('Audio swap already in progress');
    }

    this.audioSwapLock = true;
    try {
      // Always get fresh sender reference from the peerConnection
      const senders = this.peerConnection.getSenders();
      const audioSender = senders.find(s => s.track?.kind === 'audio');

      if (!audioSender) {
        throw new Error('No audio sender found');
      }

      // Validate connection state
      if (this.peerConnection.connectionState !== 'connected' && this.peerConnection.connectionState !== 'connecting') {
        throw new Error(`Invalid state: ${this.peerConnection.connectionState}`);
      }

      // Retry logic
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await audioSender.replaceTrack(syntheticTrack);
          this.syntheticTrack = syntheticTrack;
          this.trackHistory.push({
            track: syntheticTrack,
            type: 'synthetic',
            created: Date.now()
          });
          console.log('Successfully replaced microphone with synthetic audio');
          return;
        } catch (err: any) {
          console.error(`replaceWithSynthetic attempt ${attempt} failed:`, err?.message || err);
          if ((err?.message || '').includes('closed') || (err?.message || '').includes('failed')) {
            // try to let caller refresh or reinitialize peer connection
            // fallthrough to retry after backoff
          }

          if (attempt < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            await new Promise(res => setTimeout(res, delay));
          }
        }
      }

      throw new Error('Failed to replace track after retries');
    } finally {
      this.audioSwapLock = false;
    }
  }

  async restoreOriginalTrack(): Promise<void> {
    if (!this.peerConnection || !this.originalTrack) {
      throw new Error('No original track or peer connection available');
    }

    // Get fresh sender reference
    const senders = this.peerConnection.getSenders();
    const audioSender = senders.find(s => s.track?.kind === 'audio');

    if (!audioSender) {
      throw new Error('No audio sender available');
    }

    // Attempt the replace with a small retry loop
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await audioSender.replaceTrack(this.originalTrack);
        console.log('Successfully restored original microphone');

        // Clean up synthetic track
        if (this.syntheticTrack) {
          this.syntheticTrack.stop();
          this.syntheticTrack = null;
        }
        return;
      } catch (error: any) {
        console.error(`restoreOriginalTrack attempt ${attempt} failed:`, error?.message || error);
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await new Promise(res => setTimeout(res, delay));
        }
      }
    }

    throw new Error('Failed to restore original track after retries');
  }

  getCurrentTrackInfo(): AudioTrackInfo | null {
    if (!this.currentSender || !this.currentSender.track) {
      return null;
    }

    const currentTrack = this.currentSender.track;
    return this.trackHistory.find(info => info.track === currentTrack) || null;
  }

  getTrackHistory(): AudioTrackInfo[] {
    return [...this.trackHistory];
  }

  async getAudioLevels(): Promise<{ original: number; synthetic: number }> {
    const levels = { original: 0, synthetic: 0 };

    if (this.originalTrack && this.originalTrack.readyState === 'live') {
      levels.original = await this.getTrackAudioLevel(this.originalTrack);
    }

    if (this.syntheticTrack && this.syntheticTrack.readyState === 'live') {
      levels.synthetic = await this.getTrackAudioLevel(this.syntheticTrack);
    }

    return levels;
  }

  private async getTrackAudioLevel(track: MediaStreamTrack): Promise<number> {
    const audioContext = new AudioContext();
    const stream = new MediaStream([track]);
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    
    source.connect(analyser);
    analyser.fftSize = 256;
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    
    const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
    
    audioContext.close();
    return average / 255; // Normalize to 0-1
  }

  cleanup(): void {
    if (this.originalTrack) {
      this.originalTrack.stop();
      this.originalTrack = null;
    }

    if (this.syntheticTrack) {
      this.syntheticTrack.stop();
      this.syntheticTrack = null;
    }

    this.trackHistory.forEach(info => {
      if (info.track.readyState === 'live') {
        info.track.stop();
      }
    });

    this.trackHistory = [];
    this.currentSender = null;
  }
}