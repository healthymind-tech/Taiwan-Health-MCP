# 部署架構圖

```mermaid
graph TD
    User[End User] --> Client[MCP Client (Claude/IDE)]
    
    subgraph "Docker Container"
        Server[MCP Server Process]
        
        subgraph "In-Process Memory"
            Services[Service Instances]
        end
        
        subgraph "Persistent Volume /data"
            DB1[(ICD DB)]
            DB2[(Drug DB)]
            Files[Raw Files]
        end
        
        Server <--> Services
        Services <--> DB1
        Services <--> DB2
    end
    
    Client -- Stdio / SSE --> Server
```

## 關鍵考量

1. **資料持久性**：Raw Files (Excel) 與 SQLite DB 均位於 `/data` Volume，確保容器重啟後無需重新進行 ETL。
2. **通訊模式**：目前預設使用 `stdio` 模式，這意味著 MCP Server 與 Client 需在同一台機器上運行（或是 Client 透過 `docker exec` 呼叫）。若需遠端部署，需改用 SSE (Server-Sent Events) 模式（目前 FastMCP 支援）。
