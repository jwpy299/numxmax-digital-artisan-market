/** v153 实习管线纯规则：判分/派单轮转 */
import { describe, expect, it } from "vitest";
import { pickInternTask, scoreInternReply, INTERN_TASKS } from "./routers/internJobs";

describe("确定性判分", () => {
  it("rubric 命中≥60% 合格，分数随命中涨", () => {
    const pass = scoreInternReply("非常抱歉给您带来不便，退货我马上为您处理，稍后专人联系您", ["抱歉","退货","处理","联系"]);
    expect(pass.pass).toBe(true);
    expect(pass.hits).toBe(4);
    const fail = scoreInternReply("你好啊", ["抱歉","退货","处理","联系"]);
    expect(fail.pass).toBe(false);
    expect(fail.hits).toBe(0);
  });
});
describe("派单轮转", () => {
  it("按技能池+完成数确定性取单", () => {
    const t1 = pickInternTask("cs", 0);
    const t2 = pickInternTask("cs", 1);
    expect(t1.forSkill).toBe("cs");
    expect(t2.forSkill).toBe("cs");
    expect(t1.taskKey).not.toBe(t2.taskKey);
    // 无技能走 general 池
    expect(pickInternTask(null, 0).forSkill).toBe("general");
    // 轮转不越界
    const n = INTERN_TASKS.filter((t) => t.forSkill === "cs").length;
    expect(pickInternTask("cs", n).taskKey).toBe(pickInternTask("cs", 0).taskKey);
  });
});
