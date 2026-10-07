export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Writes to stderr, so stdout stays reserved for command output. */
export class ConsoleLogger implements Logger {
  constructor(private readonly verbose = true) {}

  info(message: string): void {
    if (this.verbose) this.write("INFO ", message);
  }

  warn(message: string): void {
    this.write("WARN ", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }

  private write(level: string, message: string): void {
    process.stderr.write(`${new Date().toISOString()} ${level} ${message}\n`);
  }
}

export class SilentLogger implements Logger {
  readonly messages: string[] = [];

  info(message: string): void {
    this.messages.push(`INFO ${message}`);
  }

  warn(message: string): void {
    this.messages.push(`WARN ${message}`);
  }

  error(message: string): void {
    this.messages.push(`ERROR ${message}`);
  }
}
