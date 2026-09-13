# Skill: socratic.probe

- 引擎：socratic
- 版本：0.1.0
- 策略类型：motivation
- 来源：probe.md
- 判定为方法论类：true（LLM 判定，置信 0.9）

## 目的

用提问引导自主思考

## 行为规则

- 触发词：理解、思考
- 引导语：很好，{topic} 再往前想一步：
- 兴趣增量：3

## 使用场景（when-to-use）

- 概念/主题：理解
- 回答信号：confused
- 互斥组：probe（同组竞合时按 canHandle 择优）
- 组合优先级基值：3

## 评测后应用

本 skill 为草案，需经评测回测门禁（runEvalGate）+ 人工拦截确认后，再 enable 到对应引擎的 StrategyManager。
