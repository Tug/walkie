// Web: the browser/OS owns audio output; nothing to force. No-ops so App.tsx stays uniform.
export function startAudio(): void {}
export function setSpeaker(_on: boolean): void {}
export function stopAudio(): void {}
