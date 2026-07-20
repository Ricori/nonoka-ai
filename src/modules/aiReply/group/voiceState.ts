/** 开启语音回复的群（仅内存态，重启后失效） */
const voiceGroups = new Set<number>();

export function isVoiceEnabled(groupId: number) {
  return voiceGroups.has(groupId);
}

export function setVoiceEnabled(groupId: number, enable: boolean) {
  if (enable) {
    voiceGroups.add(groupId);
  } else {
    voiceGroups.delete(groupId);
  }
}
