/**
 * 活动配置文件 —— 改这里的值就行,不用碰其他代码
 */
module.exports = {
  // 主办单位名称,会显示在页面标题和大屏幕上
  ORG_NAME: '河北医科大学第一医院',

  // 活动名称
  EVENT_NAME: '病例答题比赛',

  // 参赛者扫码后要访问的网址,大屏幕会根据这个网址生成二维码
  // - 局域网内使用:填这台电脑的局域网IP,例如 'http://192.168.1.100:3000'
  //   (Windows 用 ipconfig 查看,Mac 用 系统设置 -> 网络 查看)
  // - 部署到云服务器/公网使用:填服务器的公网地址或域名,例如 'https://your-domain.com'
  SITE_URL: 'http://192.168.1.100:3000/player.html',

  // 计分规则:答对得分 = SCORE_BASE(基础分) + 剩余秒数 × SCORE_SPEED_BONUS_PER_SEC(速度加成)
  // 答错或超时未答 = 0分。改这两个数字,大屏幕底部的说明文字会自动同步显示,不用再去改代码
  SCORE_BASE: 50,
  SCORE_SPEED_BONUS_PER_SEC: 5,
};
