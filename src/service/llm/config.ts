/** LLM 模型配置 */

export const LLM_MODELS = {
  /** 主回复模型 */
  anthropicReply: 'claude-opus-4-7',
  /** 副回复模型 */
  reply: 'kimi-k2.6',
  /** 群友记忆归纳模型 */
  summarize: 'qwen3.6-plus',
  /** 翻译模型 */
  translate: 'qwen3.6-plus',
} as const;

export const LLM_PARAMS = {
  reply: { temperature: 0.8, maxTokens: 150, timeout: 20000 },
  summarize: { temperature: 0.3, maxTokens: 120, timeout: 15000 },
  anthropicReply: { temperature: 0.8, maxTokens: 150 },
} as const;
