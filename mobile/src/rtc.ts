// Native WebRTC adapter (iOS/Android). Web variant: rtc.web.ts, resolved by Metro.
import { mediaDevices, RTCPeerConnection } from "react-native-webrtc";

export function createPeerConnection(): any {
  return new RTCPeerConnection({});
}

export async function getMicStream(): Promise<any> {
  return mediaDevices.getUserMedia({ audio: true });
}

/** Remote audio plays automatically in react-native-webrtc; nothing to attach. */
export function attachRemoteAudio(_pc: any): void {}
