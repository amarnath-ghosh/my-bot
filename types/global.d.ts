// types/global.d.ts
export type BotState = "idle" | "joining" | "in_meeting" | "error" | "ended";

export interface MeetingStatus {
  meetingID: string;
  meetingName: string;
  participantCount?: number;
  isRunning?: boolean;
  botState: BotState;
  lastError?: string;
}

declare global {
  interface Window {
    botApi: {
      onMeetingsUpdate(
        cb: (meetings: MeetingStatus[]) => void
      ): void;
      getSnapshot(): Promise<MeetingStatus[]>;
      join(id: string): Promise<void>;
      leave(id: string): Promise<void>;
      restart(id: string): Promise<void>;
      setAutoManage(enabled: boolean): Promise<void>;
    };
  }
}

// Important so this file is treated as a module
export {};
