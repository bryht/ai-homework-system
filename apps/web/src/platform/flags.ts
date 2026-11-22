/**
 * chat-demo 原有功能在作业系统里的开关。
 * 改动上游文件时只引用这些开关，不删原有代码，方便以后合并 chat-demo 的更新。
 */
export const platformFlags = {
  /** API Key 由后端统一保管，前端不再填写 */
  apiKey: false,
  /** 语音输入和朗读：第一期不开放 */
  voice: false,
  /** 导入历史会让学生伪造对话记录，禁用 */
  historyImport: false,
} as const
