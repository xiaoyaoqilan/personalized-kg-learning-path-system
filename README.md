# 基于大型语言模型的个性化知识图谱构建与自适应自学路径规划系统

这是一个面向毕业设计演示的自学路径规划系统。系统从学生的学习目标出发，结合学习材料、诊断题、薄弱点记录和检索增强生成，为学生生成个性化学习路线。

## 当前功能

- 学习目标采集：记录目标、年级、学科、偏好和当前卡点。
- 学习材料整理：将上传材料切分成片段，并写入 ChromaDB。
- 知识关系生成：提取材料中的关键概念和概念关系。
- 自适应诊断：根据目标和材料生成诊断题。
- 薄弱点记录：根据答题结果记录问题点。
- 路径规划：生成补基础、新内容、复习和练习路线。
- 持续练习：围绕薄弱点继续抽题。
- RAG 问答：结合学习材料和学习记录回答问题。

## 技术组成

- 前端：HTML、CSS、JavaScript
- 后端：FastAPI
- 大模型：DeepSeek API
- 向量数据库：ChromaDB
- 图数据库：Neo4j 接口已预留，配置服务后可写入知识图谱

## 启动方式

```powershell
$env:DEEPSEEK_API_KEY="你的 DeepSeek Key"
$env:AI_PROVIDER="deepseek"
$env:DEEPSEEK_MODEL="deepseek-chat"
.\start_fastapi.ps1
```

访问：

```text
http://127.0.0.1:4177/
```

## Neo4j 配置

如果需要连接本地 Neo4j：

```powershell
$env:NEO4J_URI="bolt://localhost:7687"
$env:NEO4J_USER="neo4j"
$env:NEO4J_PASSWORD="你的密码"
.\start_fastapi.ps1
```

未配置 Neo4j 时，系统仍可运行，知识关系会返回给前端展示，并保留写入图数据库的接口。
