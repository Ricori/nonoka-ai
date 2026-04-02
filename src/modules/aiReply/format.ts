import { getImgs, hasImage } from '@/utils/function';
import { SimpleMessageData } from '@/types/event';
import { FormattedMessage } from '../../types/message';

function clean(rawText: string, cleanImage = false) {
  let text = rawText.replace(/\[CQ:face,.*\]/g, '[表情]')
    .replace(/\[CQ:video,.*\]/g, '[视频]')
    .replace(/\[CQ:record,.*\]/g, '[语音]')
    .replace(/\[CQ:json[\s\S]*?"desc"\s*:\s*"([^"]+)"[\s\S]*?\]/g, '分享了文章《$1》')
    .replace(/\[CQ:forward,.*\]/g, '[聊天记录]')
    .replace(/\[CQ:at,qq=([^,]+)\]/g, '')
    .replace(/\[CQ:reply,id=([^,]+)\]/g, '');

  if (cleanImage) {
    text = text.replace(/\[CQ:image,[^\]]+\]/g, '[图片]');
  }
  text = text.trimStart();
  return text;
}


export function formatMessage(
  params: {
    selfId: number,
    userId: number,
    nickName: string,
    rawMessage: string,
    replyMessage?: SimpleMessageData,
    cleanImage: boolean
  },
): FormattedMessage {
  const {
    selfId, userId, nickName, rawMessage, replyMessage, cleanImage = false,
  } = params;

  let isMentionMe = rawMessage.indexOf(`[CQ:at,qq=${selfId}]`) > -1;

  let prefix = '';

  if (replyMessage) {
    const isBot = replyMessage.sender.user_id === selfId; // 是否引用自己的消息
    if (isBot) {
      isMentionMe = true;
    }
    prefix = `[${nickName}]回复了${isBot ? '我' : replyMessage.sender.nickname || ''}的消息`;
    const rtext = clean(replyMessage.message).replace(/\[CQ:image,[^\]]+\]/g, '[之前的图片]');
    prefix += `(${rtext.slice(0, 90)})，说：`;
  } else {
    prefix = `[${nickName}]${isMentionMe ? '提到我' : ''}说：`;
  }


  if (!hasImage(rawMessage)) {
    return {
      role: 'user', userId, isMentionMe, message: prefix + clean(rawMessage),
    };
  }

  if (cleanImage) {
    return {
      role: 'user', userId, isMentionMe, message: prefix + clean(rawMessage, true),
    };
  }

  const img = getImgs(rawMessage, true)[0];
  const isSticker = img.summary === '[动画表情]' || Number(img.file_size || 0) < 60 * 1024;

  if (isSticker) {
    // 动画表情或小于60kb的图片视为表情，降成纯文本
    const text = clean(rawMessage).replace(/\[CQ:image,[^\]]+\]/g, '[表情]').trim();
    return {
      role: 'user', userId, isMentionMe, message: prefix + text,
    };
  }

  return {
    role: 'user',
    userId,
    isMentionMe,
    message: prefix + clean(rawMessage, true),
    imgUrl: img.url,
  };
}


export function formatAssistantMessage(text: string): FormattedMessage {
  return {
    role: 'assistant',
    userId: 0,
    isMentionMe: false,
    message: text,
  };
}

export function formatInitiativePromptMessage(): FormattedMessage {
  return {
    role: 'assistant',
    userId: 0,
    isMentionMe: false,
    message: '（System：群友并没有@你，请根据上面的对话自然地随机插一句嘴，刷一下存在感）',
  };
}


export function formatUserMemoryPromptMessage(userMemoryContext: string): FormattedMessage | null {
  if (userMemoryContext === '') return null;
  return {
    role: 'assistant',
    userId: 0,
    isMentionMe: false,
    message: `（System：【群友档案】利用以下情报与群友自然对话，但切忌直白地说“你的档案里写着”这种话：\n${userMemoryContext}）`,
  };
}
