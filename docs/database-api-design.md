# 数据库与接口设计

## 数据存储设计

### ChromaDB：学习材料片段

用于存储用户上传材料的文本片段和向量表示。

字段：

| 字段 | 说明 |
| --- | --- |
| id | 片段 ID |
| sourceId | 材料 ID |
| title | 材料名称 |
| document | 材料片段文本 |
| embedding | 文本向量 |

用途：

- 诊断题生成前检索相关材料。
- RAG 问答时提供材料依据。
- 后续可扩展为多材料、多用户学习库。

### Neo4j：知识图谱

用于存储知识点节点和概念关系。

节点：

```cypher
(:KnowledgePoint {
  name: string,
  subject: string
})
```

关系：

```cypher
(:KnowledgePoint)-[:RELATED {
  label: string
}]->(:KnowledgePoint)
```

用途：

- 表达概念之间的前置、关联和补充关系。
- 为学习路径排序提供结构依据。
- 后续可用于图谱可视化。

## 接口设计

### GET /api/status

返回系统运行状态。

返回示例：

```json
{
  "ok": true,
  "backend": "FastAPI",
  "provider": "deepseek",
  "model": "deepseek-chat",
  "apiConfigured": true,
  "neo4jConnected": false,
  "chromaConnected": true,
  "dailyLimit": 30,
  "remaining": 30
}
```

### POST /api/index

整理学习材料并写入 ChromaDB。

请求：

```json
{
  "title": "机器学习笔记",
  "text": "材料内容",
  "profile": {
    "goal": "学习机器学习",
    "subject": "计算机"
  }
}
```

返回：

```json
{
  "source": {
    "id": "source_001",
    "title": "机器学习笔记",
    "chunkCount": 3
  },
  "graph": {
    "nodes": ["模型", "训练", "损失函数"],
    "edges": []
  },
  "storage": {
    "chroma": true,
    "neo4j": false
  }
}
```

### POST /api/diagnose

根据学习画像和材料生成诊断题。

### POST /api/plan

根据答题结果和薄弱点生成学习路线。

### POST /api/practice

根据薄弱点继续抽题。

### POST /api/rag

结合学习材料和学习记录回答用户问题。

## 接口设计特点

- 前端只调用统一 JSON 接口。
- 后端负责检索、模型调用和兜底处理。
- 大模型输出被要求为结构化 JSON，便于前端渲染。
- 即使外部模型不可用，系统仍能返回本地兜底结果，保证演示稳定。
