import { DeepgramResponse, TranscriptSegment, WordSegment } from './types';
import WebSocket from 'ws';

export interface TranscriptionConfig {
  apiKey: string;
  language?: string;
  model?: string;
  diarize?: boolean;
  punctuate?: boolean;
  profanityFilter?: boolean;
}

export class TranscriptionService {
  private ws: WebSocket | null = null;
  private config: Required<TranscriptionConfig>;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 3;

  constructor(config: TranscriptionConfig) {
    this.config = {
      language: 'en',
      model: 'nova-2-meeting', // Use the meeting-specific model
      diarize: true,
      punctuate: true,
      profanityFilter: false,
      ...config,
    };
  }

  async connect(
    onTranscript: (segment: TranscriptSegment, data: DeepgramResponse) => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    try {
      const params = new URLSearchParams({
        language: this.config.language,
        model: this.config.model,
        diarize: this.config.diarize.toString(),
        punctuate: this.config.punctuate.toString(),
        profanity_filter: this.config.profanityFilter.toString(),
        interim_results: 'true',
        endpointing: '300',
        smart_format: 'true',
        encoding: 'linear16',
        sample_rate: '16000',
      });

      const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

      this.ws = new WebSocket(url, ['token', this.config.apiKey]);

      this.ws.onopen = () => {
        console.log('Deepgram WebSocket connection opened');
        this.isConnected = true;
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event: any) => {
        try {
          const data: DeepgramResponse = JSON.parse(event.data as string);

          if (data.channel?.alternatives?.[0]?.transcript) {
            const segment = this.processDeepgramResponse(data);
            onTranscript(segment, data); // Pass the full data object
          }
        } catch (error) {
          console.error('Error processing Deepgram response:', error);
          if (onError) {
            onError(error as Error);
          }
        }
      };

      this.ws.onerror = (event: any) => {
        console.error('Deepgram WebSocket error:', onError);
        this.isConnected = false;
        if (onError) {
          onError(new Error('WebSocket connection error'));
        }
      };

      this.ws.onclose = (event: any) => {
        console.log('Deepgram WebSocket closed:', event.code, event.reason);
        this.isConnected = false;

        // Attempt to reconnect if not intentionally closed
        if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          setTimeout(() => {
            this.reconnectAttempts++;
            this.connect(onTranscript, onError);
          }, 2000 * this.reconnectAttempts);
        }
      };
    } catch (error) {
      console.error('Error connecting to Deepgram:', error);
      if (onError) {
        onError(error as Error);
      }
    }
  }

  sendAudio(audioData: ArrayBuffer): void {
    if (this.ws && this.isConnected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(audioData);
    } else {
      console.warn('WebSocket is not connected, cannot send audio data');
    }
  }

  private processDeepgramResponse(data: DeepgramResponse): TranscriptSegment {
    const alternative = data.channel.alternatives[0];
    const words: WordSegment[] =
      alternative.words?.map(word => ({
        word: word.word,
        startTime: word.start * 1000, // Convert to milliseconds
        endTime: word.end * 1000,
        confidence: word.confidence,
        speaker: word.speaker,
      })) || [];

    // Determine speaker index from words
    const speakerIndex =
      words.length > 0 && words[0].speaker !== undefined ? words[0].speaker : 0;

    return {
      speaker: `Speaker ${speakerIndex}`,
      speakerIndex,
      text: alternative.transcript,
      startTime: words.length > 0 ? words[0].startTime : Date.now(),
      endTime: words.length > 0 ? words[words.length - 1].endTime : Date.now(),
      confidence: alternative.confidence,
      words,
      isFinal: data.is_final, // Pass this property
    };
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close(1000, 'Intentional disconnect');
      this.ws = null;
      this.isConnected = false;
    }
  }

  isWebSocketConnected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }
}