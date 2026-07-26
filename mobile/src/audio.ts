// Native audio routing. react-native-webrtc forces the iOS earpiece route on connect, so a
// voice reply is inaudible unless the phone is held to the ear. We drive the route with
// react-native-incall-manager: default to loudspeaker, and let the user flip to earpiece/
// AirPods (when AirPods are connected and speaker is off, iOS routes to them automatically).
import InCallManager from "react-native-incall-manager";

export function startAudio(): void {
  try {
    InCallManager.start({ media: "audio" });
    InCallManager.setForceSpeakerphoneOn(true);
  } catch {
    /* best effort */
  }
}

/** true = loudspeaker; false = release the forced route (earpiece, or connected AirPods). */
export function setSpeaker(on: boolean): void {
  try {
    InCallManager.setForceSpeakerphoneOn(on);
  } catch {
    /* best effort */
  }
}

export function stopAudio(): void {
  try {
    InCallManager.stop();
  } catch {
    /* best effort */
  }
}
