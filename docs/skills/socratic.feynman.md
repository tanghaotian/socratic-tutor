# Skill: socratic.feynman

- 引擎：socratic
- 版本：1.0.0
- 策略类型：adaptivity
- 来源：knowledge/skills/feynman-technique.md
- 判定为方法论类：true（LLM 判定，置信 0.95）

## 目的

通过让学习者用通俗语言复述概念来暴露理解漏洞并强化深度掌握

## 行为规则

- 触发词：解释、说明、大白话、类比、例子、卡壳、听不懂、似懂非懂
- 引导语：试着把 {topic} 讲给一个完全不懂的人听，你会怎么开头？
- 兴趣增量：3

## 使用场景（when-to-use）

- 概念/主题：概念、原理、定义、机制
- 回答信号：confused、mistake、divergent
- 互斥组：feynman_technique_group（同组竞合时按 canHandle 择优）
- 组合优先级基值：8

## 评测后应用

本 skill 为草案，需经评测回测门禁（runEvalGate）+ 人工拦截确认后，再 enable 到对应引擎的 StrategyManager。
