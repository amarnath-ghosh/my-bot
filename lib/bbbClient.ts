// lib/bbbClient.ts
import crypto from "crypto";
import axios from "axios";
import { parseStringPromise } from "xml2js";

export interface BbbMeeting {
  meetingID: string;
  meetingName: string;
  createTime?: string;
  participantCount?: number;
  isRunning?: boolean;
}

export class BbbClient {
  private baseUrl: string;
  private secret: string;

  constructor() {
    this.baseUrl = process.env.NEXT_PUBLIC_BBB_EMPLOYABILITY_API_URL!;
    this.secret = process.env.NEXT_PUBLIC_BBB_EMPLOYABILITY_SECRET!;
    console.log("[BbbClient] Initialized with Base URL:", this.baseUrl);
    if (!this.baseUrl) console.error("[BbbClient] ERROR: BBB_BASE_URL is missing!");
  }

  private sign(method: string, params: URLSearchParams = new URLSearchParams()) {
    const query = params.toString();
    const checksumPayload = method + query + this.secret;
    const checksum = crypto
      .createHash("sha1")
      .update(checksumPayload)
      .digest("hex");

    const separator = query ? "&" : "?";
    const queryString = query ? `?${query}` : "";
    return `${this.baseUrl}/${method}${queryString}${separator}checksum=${checksum}`;
  }

  async getMeetings(): Promise<BbbMeeting[]> {
    const url = this.sign("getMeetings");
    console.log("[BbbClient] Fetching meetings from:", url);

    try {
      const res = await axios.get(url, {
        responseType: "text",
        validateStatus: () => true // Handle 400/500 errors manually
      });

      console.log("[BbbClient] Response status:", res.status);

      // Check if response is JSON (error)
      if (typeof res.data === 'string' && res.data.trim().startsWith('{')) {
        console.error("[BbbClient] Received JSON response (likely error):", res.data);
        return [];
      }

      const xml = res.data as string;
      const parsed = await parseStringPromise(xml, { explicitArray: false });

      if (parsed.response?.returncode === 'FAILED') {
        console.error("[BbbClient] API returned FAILED:", parsed.response.message);
        return [];
      }

      const meetings = parsed.response.meetings?.meeting || [];
      const list = Array.isArray(meetings) ? meetings : [meetings];

      return list
        .filter(Boolean)
        .map((m: any) => ({
          meetingID: m.meetingID,
          meetingName: m.meetingName,
          createTime: m.createTime,
          participantCount: m.participantCount
            ? Number(m.participantCount)
            : undefined,
          isRunning: m.running === "true",
        }));
    } catch (err) {
      console.error("[BbbClient] getMeetings error:", err);
      return [];
    }
  }

  buildJoinUrl(params: {
    meetingID: string;
    fullName: string;
    password: string;
    userID?: string;
  }): string {
    const queryParams = new URLSearchParams({
      meetingID: params.meetingID,
      fullName: params.fullName,
      password: params.password,
      ...(params.userID ? { userID: params.userID } : {}),
    });

    const method = "join";
    const query = queryParams.toString();
    const checksumPayload = method + query + this.secret;
    const checksum = crypto
      .createHash("sha1")
      .update(checksumPayload)
      .digest("hex");

    return `${this.baseUrl}/${method}?${query}&checksum=${checksum}`;
  }
}
