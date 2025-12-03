import axios from 'axios';
import * as crypto from 'crypto';
import { parseStringPromise } from 'xml2js';

// Configuration loaded from .env
const BBB_CONFIG = {
  apiBase: process.env.NEXT_PUBLIC_BBB_EMPLOYABILITY_API_URL || 'https://bbb.employability.life/bigbluebutton/api',
  secret: process.env.NEXT_PUBLIC_BBB_EMPLOYABILITY_SECRET || '', 
  botName: 'AI_NoteTaker',
  attendeePW: process.env.NEXT_PUBLIC_BBB_EMPLOYABILITY_PASSWORD || 'ap'
};

// Robustness: Remove trailing slash to prevent double // in URL
if (BBB_CONFIG.apiBase.endsWith('/')) {
  BBB_CONFIG.apiBase = BBB_CONFIG.apiBase.slice(0, -1);
}

export class BBBMonitor {
  private joinedMeetings: Set<string> = new Set();
  private checkInterval: NodeJS.Timeout | null = null;
  private onMeetingDetected: (joinUrl: string, meetingId: string) => void;

  constructor(onMeetingDetected: (url: string, id: string) => void) {
    this.onMeetingDetected = onMeetingDetected;
    if (!BBB_CONFIG.secret) console.error('[BBB Monitor] ❌ FATAL: No Secret found in .env!');
  }

  private getChecksum(callName: string, queryParams: string): string {
    const stringToHash = callName + queryParams + BBB_CONFIG.secret;
    return crypto.createHash('sha1').update(stringToHash).digest('hex');
  }

  public start(intervalMs: number = 3000) {
    console.log(`[BBB Monitor] Started watching ${BBB_CONFIG.apiBase}...`);
    this.checkMeetings(); 
    this.checkInterval = setInterval(() => this.checkMeetings(), intervalMs);
  }

  public stop() {
    if (this.checkInterval) clearInterval(this.checkInterval);
  }

  private async checkMeetings() {
    try {
      const method = 'getMeetings';
      const checksum = this.getChecksum(method, '');
      const url = `${BBB_CONFIG.apiBase}/${method}?checksum=${checksum}`;

      // Robustness: Request 'text' to handle both JSON and XML without crashing
      const response = await axios.get(url, { timeout: 5000, responseType: 'text' });
      const rawData = response.data;

      if (!rawData || typeof rawData !== 'string') return;

      const firstChar = rawData.trim().charAt(0);

      // Handle JSON (Fixes "Non-whitespace" error)
      if (firstChar === '[' || firstChar === '{') {
        this.handleJsonResponse(rawData);
        return;
      }

      // Handle XML (Standard BBB)
      if (firstChar === '<') {
        await this.handleXmlResponse(rawData);
        return;
      }
    } catch (error) {
      console.error('[BBB Monitor] Polling Error:', error instanceof Error ? error.message : error);
    }
  }

  private async handleXmlResponse(xmlData: string) {
    const result = await parseStringPromise(xmlData);
    if (result.response.returncode[0] !== 'SUCCESS') return;

    const meetings = result.response.meetings?.[0]?.meeting;
    if (!meetings) return; 

    const meetingList = Array.isArray(meetings) ? meetings : [meetings];
    for (const meeting of meetingList) {
      const pw = BBB_CONFIG.attendeePW || meeting.attendeePW[0];
      this.processMeeting(meeting.meetingID[0], pw);
    }
  }

  private handleJsonResponse(jsonData: string) {
    try {
      const parsed = JSON.parse(jsonData);
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) return;
        parsed.forEach((meeting: any) => {
          const id = meeting.meetingID || meeting.meetingId || meeting.id;
          const pw = BBB_CONFIG.attendeePW || meeting.attendeePW || meeting.attendeePw;
          if (id && pw) this.processMeeting(id, pw);
        });
      } 
    } catch (e) {
      console.error('[BBB Monitor] Failed to parse JSON:', e);
    }
  }

  private processMeeting(meetingID: string, attendeePW: string) {
    if (!this.joinedMeetings.has(meetingID)) {
      console.log(`[BBB Monitor] 🚨 New meeting detected: ${meetingID}`);
      this.joinedMeetings.add(meetingID);
      const joinUrl = this.generateJoinUrl(meetingID, attendeePW);
      this.onMeetingDetected(joinUrl, meetingID);
    }
  }

  private generateJoinUrl(meetingID: string, password: string): string {
    const params = `fullName=${encodeURIComponent(BBB_CONFIG.botName)}&meetingID=${meetingID}&password=${password}&redirect=true`;
    const checksum = this.getChecksum('join', params);
    return `${BBB_CONFIG.apiBase}/join?${params}&checksum=${checksum}`;
  }
}