// 必须是入口文件的第一个 import：libuv 线程池在第一次异步文件 IO 时才建，建好后改环境变量就没用了。
// 默认只有 4 个线程，全文搜索、AI 并发读文件、检查点都挤在这 4 个线程上；调到 16（用户自己设了就不动）
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16'
export {}
