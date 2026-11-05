export class QuotaError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const messages = {
  NETWORK: '额度接口暂时无法连接',
  TIMEOUT: '额度接口读取超时',
  REDIRECT: '额度接口发生重定向，已拒绝跟随',
  HTTP: '额度接口返回非成功状态',
  CONTENT_TYPE: '额度接口没有返回 JSON',
  TOO_LARGE: '额度接口响应超出大小限制',
  SCHEMA: '额度接口结构无法识别',
  JSON: '额度接口 JSON 无法解析',
  NOT_CONFIGURED: '聚合服务尚未配置，请联系额度服务维护者',
  UPSTREAM: '聚合服务报告错误；原始错误已隐藏',
  LIMIT: '窗口超过原生宿主的 32 项上限，请查看桌面明细',
  CREDENTIAL: '重置卡查询凭证缺失、无效或被拒绝；请在服务端项目外凭证文件中配置',
};

export const errorMessage = (code) => messages[code] ?? '额度读取失败';
