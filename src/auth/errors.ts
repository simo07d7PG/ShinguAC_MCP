const CONFIG_GUIDE =
  "환경변수 SHINGU_ID, SHINGU_PW 또는 설정 파일 ~/.shingu-mcp/config.json 의 학번/비밀번호를 확인해 주세요.";

abstract class AuthError extends Error {
  abstract readonly userAction: string;
}

export class AuthRejectedError extends AuthError {
  readonly userAction = CONFIG_GUIDE;
  constructor() {
    super(`포털이 로그인을 거부했습니다. 학번/비밀번호가 올바른지 확인해 주세요. ${CONFIG_GUIDE}`);
    this.name = "AuthRejectedError";
  }
}

export class AuthUnsupportedError extends AuthError {
  readonly userAction = "학생 계정으로 로그인해 주세요.";
  constructor() {
    super("학생 계정만 지원합니다. 교직원 등 다른 계정 유형은 사용할 수 없습니다.");
    this.name = "AuthUnsupportedError";
  }
}

export class LoginFailedError extends AuthError {
  readonly userAction = "잠시 후 다시 시도해 주세요. 계속되면 포털 점검 여부를 확인해 주세요.";
  constructor(detail: string) {
    super(`포털 로그인에 실패했습니다: ${detail}`);
    this.name = "LoginFailedError";
  }
}

/** 쓰기 요청이 만료된 세션으로 나가 처리되지 않았다. 중복 위험 때문에 자동 재전송하지 않는다. */
export class WriteSessionLostError extends AuthError {
  readonly userAction = "제출 상태를 확인한 뒤 다시 시도해 주세요.";
  constructor() {
    super("포털 세션이 만료되어 요청이 처리되지 않았습니다(쓰기 요청은 자동으로 다시 보내지 않습니다).");
    this.name = "WriteSessionLostError";
  }
}

export class SessionExpiredError extends AuthError {
  readonly userAction = "잠시 후 다시 시도해 주세요. 계속되면 포털에서 로그아웃 상태인지 확인해 주세요.";
  constructor() {
    super("재로그인 후에도 포털 세션이 만료 상태입니다.");
    this.name = "SessionExpiredError";
  }
}
