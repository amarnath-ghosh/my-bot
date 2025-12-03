import { ParticipantData, TranscriptSegment, SentimentScore, MeetingSession } from './types';

export interface AnalyticsExportOptions {
  format: 'json' | 'csv' | 'xlsx';
  includeTranscript: boolean;
  includeSentiment: boolean;
  includeWordTiming: boolean;
}

export class AnalyticsService {
  private participants: Map<string, ParticipantData> = new Map();
  private currentSession: MeetingSession | null = null;
  private speakerMapping: Map<number, string> = new Map();

  startSession(sessionId: string, meetingUrl: string): void {
    this.currentSession = {
      id: sessionId,
      url: meetingUrl,
      startTime: Date.now(),
      endTime: null,
      participants: [],
      totalTranscript: []
    };
  }

  endSession(): MeetingSession | null {
    if (this.currentSession) {
      this.currentSession.endTime = Date.now();
      this.currentSession.participants = Array.from(this.participants.values());
      
      // Calculate final attendance times
      this.currentSession.participants.forEach(participant => {
        if (!participant.leaveTimestamp) {
          participant.leaveTimestamp = this.currentSession!.endTime!;
          participant.totalTimeAttended = participant.leaveTimestamp - participant.joinTimestamp;
        }
      });
    }
    
    return this.currentSession;
  }

  addParticipant(userId: string, userName: string, speakerIndex?: number): void {
    if (this.participants.has(userId)) {
      return; // Participant already exists
    }

    const participant: ParticipantData = {
      userId,
      userName,
      joinTimestamp: Date.now(),
      leaveTimestamp: null,
      transcript: [],
      totalTimeAttended: 0,
      totalTimeSpoken: 0,
      sentiment: {
        overall: 'neutral',
        score: 0,
        emotions: {
          joy: 0,
          sadness: 0,
          anger: 0,
          fear: 0
        }
      }
    };

    this.participants.set(userId, participant);

    if (speakerIndex !== undefined) {
      this.speakerMapping.set(speakerIndex, userId);
    }
  }

  mapSpeakerToParticipant(speakerIndex: number, userId: string): void {
    this.speakerMapping.set(speakerIndex, userId);
  }

  addTranscriptSegment(segment: TranscriptSegment): void {
    // Try to map speaker index to participant
    const userId = this.speakerMapping.get(segment.speakerIndex) || `unknown_${segment.speakerIndex}`;
    
    // Create unknown participant if needed
    if (!this.participants.has(userId)) {
      this.addParticipant(userId, segment.speaker, segment.speakerIndex);
    }

    const participant = this.participants.get(userId);
    if (participant) {
      participant.transcript.push(segment);
      participant.totalTimeSpoken += (segment.endTime - segment.startTime);
    }

    // Add to session transcript
    if (this.currentSession) {
      this.currentSession.totalTranscript.push(segment);
    }
  }

  updateParticipantSentiment(userId: string, sentiment: SentimentScore): void {
    const participant = this.participants.get(userId);
    if (participant) {
      participant.sentiment = sentiment;
    }
  }

  analyzeSentiment(text: string): SentimentScore {
    // Simple sentiment analysis - in production, use a proper sentiment analysis service
    const positiveWords = ['good', 'great', 'excellent', 'amazing', 'fantastic', 'wonderful', 'perfect', 'love', 'like', 'happy', 'pleased'];
    const negativeWords = ['bad', 'terrible', 'awful', 'horrible', 'hate', 'dislike', 'angry', 'frustrated', 'disappointed', 'sad'];
    
    const words = text.toLowerCase().split(/\s+/);
    let positiveCount = 0;
    let negativeCount = 0;
    
    words.forEach(word => {
      if (positiveWords.some(pos => word.includes(pos))) positiveCount++;
      if (negativeWords.some(neg => word.includes(neg))) negativeCount++;
    });
    
    const totalSentimentWords = positiveCount + negativeCount;
    let score = 0;
    let overall: 'positive' | 'neutral' | 'negative' = 'neutral';
    
    if (totalSentimentWords > 0) {
      score = (positiveCount - negativeCount) / totalSentimentWords;
      if (score > 0.2) overall = 'positive';
      else if (score < -0.2) overall = 'negative';
    }
    
    return {
      overall,
      score,
      emotions: {
        joy: Math.max(0, score),
        sadness: Math.max(0, -score),
        anger: negativeCount > 2 ? 0.3 : 0,
        fear: 0
      }
    };
  }

  markParticipantLeft(userId: string): void {
    const participant = this.participants.get(userId);
    if (participant && !participant.leaveTimestamp) {
      participant.leaveTimestamp = Date.now();
      participant.totalTimeAttended = participant.leaveTimestamp - participant.joinTimestamp;
    }
  }

  getParticipantStats(userId: string): ParticipantData | null {
    return this.participants.get(userId) || null;
  }

  getAllParticipants(): ParticipantData[] {
    return Array.from(this.participants.values());
  }

  getSessionSummary(): {
    totalParticipants: number;
    totalDuration: number;
    totalWords: number;
    averageParticipation: number;
    sentimentDistribution: { positive: number; neutral: number; negative: number };
  } {
    const participants = this.getAllParticipants();
    const totalWords = participants.reduce((sum, p) => sum + p.transcript.reduce((wordSum, seg) => wordSum + seg.text.split(' ').length, 0), 0);
    const totalSpokenTime = participants.reduce((sum, p) => sum + p.totalTimeSpoken, 0);
    const totalSessionTime = this.currentSession ? (this.currentSession.endTime || Date.now()) - this.currentSession.startTime : 0;
    
    const sentimentCounts = participants.reduce(
      (acc, p) => {
        acc[p.sentiment.overall]++;
        return acc;
      },
      { positive: 0, neutral: 0, negative: 0 }
    );

    return {
      totalParticipants: participants.length,
      totalDuration: totalSessionTime,
      totalWords,
      averageParticipation: totalSessionTime > 0 ? (totalSpokenTime / totalSessionTime) * 100 : 0,
      sentimentDistribution: sentimentCounts
    };
  }

  exportData(options: AnalyticsExportOptions = {
    format: 'json',
    includeTranscript: true,
    includeSentiment: true,
    includeWordTiming: false
  }): string {
    const data = this.prepareExportData(options);
    
    switch (options.format) {
      case 'csv':
        return this.exportAsCSV(data, options);
      case 'xlsx':
        // Would require a library like xlsx
        throw new Error('XLSX export not implemented. Use json or csv format.');
      default:
        return JSON.stringify(data, null, 2);
    }
  }

  private prepareExportData(options: AnalyticsExportOptions): any {
    const participants = this.getAllParticipants();
    
    return {
      session: this.currentSession,
      summary: this.getSessionSummary(),
      participants: participants.map(p => ({
        userId: p.userId,
        userName: p.userName,
        joinTimestamp: p.joinTimestamp,
        leaveTimestamp: p.leaveTimestamp,
        totalTimeAttended: p.totalTimeAttended,
        totalTimeSpoken: p.totalTimeSpoken,
        ...(options.includeSentiment && { sentiment: p.sentiment }),
        ...(options.includeTranscript && { 
          transcript: p.transcript.map(seg => ({
            speaker: seg.speaker,
            text: seg.text,
            startTime: seg.startTime,
            endTime: seg.endTime,
            confidence: seg.confidence,
            ...(options.includeWordTiming && { words: seg.words })
          }))
        })
      })),
      exportTimestamp: Date.now()
    };
  }

  private exportAsCSV(data: any, options: AnalyticsExportOptions): string {
    // Build CSV with proper escaping of quotes/newlines and JSON-encoding for objects.
    const headers = [
      'User ID',
      'User Name',
      'Join Time',
      'Leave Time',
      'Time Attended (min)',
      'Time Spoken (min)',
      'Words Spoken',
      ...(options.includeSentiment ? ['Sentiment', 'Sentiment Score'] : [])
    ];

    const countWords = (text: string | undefined): number => {
      if (!text) return 0;
      return text
        .split(/\s+/)
        .map(w => w.trim())
        .filter(Boolean).length;
    };

    const formatCell = (cell: any): string => {
      if (cell === null || cell === undefined) return '';
      if (typeof cell === 'string') return cell;
      if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
      // For objects/arrays, JSON-encode so they appear sensibly in a CSV cell
      try {
        return JSON.stringify(cell);
      } catch (e) {
        return String(cell);
      }
    };

    const escapeForCSV = (raw: any): string => {
      const s = formatCell(raw);
      // Double any existing quotes, and wrap whole cell in quotes
      const escaped = s.replace(/"/g, '""');
      return `"${escaped}"`;
    };

    const rows = data.participants.map((p: any) => {
      const wordsSpoken = p.transcript
        ? p.transcript.reduce((sum: number, seg: any) => sum + countWords(seg.text), 0)
        : 0;

      const joinTime = p.joinTimestamp ? new Date(p.joinTimestamp).toISOString() : '';
      const leaveTime = p.leaveTimestamp ? new Date(p.leaveTimestamp).toISOString() : 'Still in meeting';

      const base = [
        p.userId || '',
        p.userName || '',
        joinTime,
        leaveTime,
        (typeof p.totalTimeAttended === 'number' ? (p.totalTimeAttended / 60000).toFixed(2) : ''),
        (typeof p.totalTimeSpoken === 'number' ? (p.totalTimeSpoken / 60000).toFixed(2) : ''),
        wordsSpoken
      ];

      if (options.includeSentiment) {
        base.push(p.sentiment?.overall || 'neutral');
        const score = (p.sentiment && typeof p.sentiment.score === 'number') ? p.sentiment.score.toFixed(3) : '0';
        base.push(score);
      }

      return base;
    });

    // Assemble CSV text. Prepend UTF-8 BOM so Excel recognizes UTF-8 encoding on Windows.
    const lines = [headers, ...rows].map((row: any[]) => row.map((cell: any) => escapeForCSV(cell)).join(','));
    return '\uFEFF' + lines.join('\n');
  }

  downloadExport(filename: string, options: AnalyticsExportOptions): void {
    const data = this.exportData(options);
    const mimeType = options.format === 'csv' ? 'text/csv' : 'application/json';
    const extension = options.format === 'csv' ? '.csv' : '.json';
    
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  reset(): void {
    this.participants.clear();
    this.speakerMapping.clear();
    this.currentSession = null;
  }
}
