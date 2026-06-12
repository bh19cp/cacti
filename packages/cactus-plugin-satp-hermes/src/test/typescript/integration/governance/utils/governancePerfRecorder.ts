import * as fs from "fs";
import * as path from "path";

/**
 * This file only exist for propagation test
 */
interface PerfRecord {
  run: number;
  gatewayId: string;
  key: string;
  newValue: string;
  eventReceivedNs: number;
  applyStartNs: number;
  applyEndNs: number;
}

export class GovernancePerfRecorder {
  private static instance: GovernancePerfRecorder | null = null;
  private readonly stream: fs.WriteStream;
  private run = 0;

  private constructor(outputPath: string) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    this.stream = fs.createWriteStream(outputPath, { flags: "a" });
    this.stream.write(
      "run,gatewayId,key,newValue,eventReceivedNs,applyStartNs,applyEndNs,eventToApplyNs,applyDurationNs\n",
    );
  }

  static init(outputPath: string): GovernancePerfRecorder {
    GovernancePerfRecorder.instance = new GovernancePerfRecorder(outputPath);
    return GovernancePerfRecorder.instance;
  }

  static reset(): void {
    GovernancePerfRecorder.instance = null;
  }

  static get(): GovernancePerfRecorder | null {
    return GovernancePerfRecorder.instance;
  }

  record(r: PerfRecord): void {
    const eventToApply = r.applyStartNs - r.eventReceivedNs;
    const applyDuration = r.applyEndNs - r.applyStartNs;
    this.stream.write(
      `${r.run},${r.gatewayId},${r.key},${r.newValue},${r.eventReceivedNs},${r.applyStartNs},${r.applyEndNs},${eventToApply},${applyDuration}\n`,
    );
  }

  nextRun(): number {
    return ++this.run;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.stream.end((err: Error | null | undefined) =>
        err ? reject(err) : resolve(),
      ),
    );
  }
}
