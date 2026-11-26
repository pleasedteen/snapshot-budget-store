# 自带夹具

`offline-map-station/` 是由 `scripts/make-fixtures.mjs` 生成的三天离线地图工作站构建产物：

- 包含 JSON、文本和确定性的二进制 `.mvt` 瓦片；
- 相邻日期保留大量字节相同的瓦片，用于验证内容去重；
- 第二天新增瓦片，第三天修改并新增瓦片。

可随时运行 `node scripts/make-fixtures.mjs` 重新生成；不需要网络或外部服务。
