// Browser WebRTC adapter: same three entry points as rtc.ts, on web globals.
const g = globalThis as any;

export function createPeerConnection(): any {
  return new g.RTCPeerConnection();
}

export async function getMicStream(): Promise<any> {
  return g.navigator.mediaDevices.getUserMedia({ audio: true });
}

/** Browsers need an <audio> element to play the remote track. */
export function attachRemoteAudio(pc: any): void {
  pc.ontrack = (e: any) => {
    const audio = new g.Audio();
    audio.autoplay = true;
    audio.srcObject = e.streams[0];
  };
}
