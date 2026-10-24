'use strict';
/**
 * 指标抽取 · 纯函数
 *
 * 输入是「原料」：接口返回的 JSON、页面 innerText、页面全局状态。
 * 输出是统一的 account / works 结构。
 *
 * 为什么不用写死的 selector：
 *   平台后台两三个月改一次版，selector 是第一个死的。反而接口字段名和
 *   「粉丝 1.2万」这种中文标签很稳定 —— 它们同时被网页、App、小程序用，
 *   平台自己不敢随便改。所以这里优先认字段名和标签，DOM 只做兜底。
 *
 * 三条铁律：
 *   1. 认不出就返回 null，绝不猜一个数字填上去。
 *   2. 同名字段出现在多个层级时，浅层优先（BFS）——深层多是「推荐关注」里的别人。
 *   3. 数字要辨单位：1.2万 是 12000，不是 1.2。
 */

// ------------------------------------------------------------ 数值
const UNIT_MUL = {
  亿: 1e8,
  万: 1e4,
  萬: 1e4,
  千: 1e3,
  百: 100,
  w: 1e4,
  W: 1e4,
  k: 1e3,
  K: 1e3,
  m: 1e6,
  M: 1e6,
  b: 1e9,
  B: 1e9
};

/**
 * "1.2万" → 12000 · "12,345" → 12345 · "3.4亿" → 340000000
 * 认不出返回 null（不是 0 —— 0 是「确认没有」，null 是「没看到」）
 */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;

  let s = v.trim();
  if (!s) return null;
  // 全角数字与千分位
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/[,，\s\u00a0]/g, '');
  // 「+」后缀表示「以上」，取值本身
  s = s.replace(/\+$/, '');

  const m = /^(-?\d+(?:\.\d+)?)(亿|万|萬|千|百|[wWkKmMbB])?$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * (m[2] ? UNIT_MUL[m[2]] : 1));
}

/** "45.6%" → 45.6；"0.456" 不加百分号的值原样返回 */
function toPct(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null;
    // 0~1 之间的小数是比例，转成百分数
    return v > 0 && v <= 1 ? Math.round(v * 1000) / 10 : Math.round(v * 10) / 10;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[,，\s]/g, '');
  const m = /^(\d+(?:\.\d+)?)%?$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** 时间戳 / 日期字符串 → YYYY-MM-DD（认不出返回 ''） */
function toDate(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) {
    let n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1e11) n *= 1000; // 秒 → 毫秒
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return '';
    // 明显不合理的年份（时区算错会偏到 1970/2100）
    const y = d.getFullYear();
    if (y < 2005 || y > 2100) return '';
    return localDate(d);
  }
  const s = String(v).trim();
  let m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // "10月22日" 这种没有年份的，补当前年
  m = /^(\d{1,2})[-/月](\d{1,2})日?$/.exec(s);
  if (m) {
    const now = new Date();
    return `${now.getFullYear()}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    if (d.getFullYear() >= 2005 && d.getFullYear() <= 2100) return localDate(d);
  }
  return '';
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ------------------------------------------------------------ 遍历
/**
 * 广度优先遍历。为什么不是深度优先：
 * 平台的接口里，第一个命中的 follower_count 往往是「推荐关注的某个大V」，
 * 而不是你自己的。浅层通常是当前登录主体，深层才是别人的引用。
 */
function bfsWalk(root, visit, { maxDepth = 9, maxNodes = 120000 } = {}) {
  if (!root || typeof root !== 'object') return;
  const queue = [{ v: root, d: 0, path: '' }];
  let head = 0;
  let n = 0;
  while (head < queue.length && n < maxNodes) {
    const cur = queue[head++];
    n++;
    if (visit(cur.v, cur.d, cur.path) === true) return;
    if (cur.d >= maxDepth) continue;
    const v = cur.v;
    if (Array.isArray(v)) {
      // 数组只往下走，不进队列太深 —— 一屏作品 500 条，全展开会卡死
      for (let i = 0; i < v.length && i < 200; i++) {
        const x = v[i];
        if (x && typeof x === 'object') queue.push({ v: x, d: cur.d + 1, path: `${cur.path}[${i}]` });
      }
    } else {
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (x && typeof x === 'object') queue.push({ v: x, d: cur.d + 1, path: cur.path ? `${cur.path}.${k}` : k });
      }
    }
  }
}

/** 路径里带这些词的大概率是「别人的东西」，命中时宁可不取 */
const OTHERS = /recommend|suggest|related|similar|others|rank(ing)?|hot|trending|discover|feed|timeline|comment|reply|audience/i;

// ------------------------------------------------------------ 账号指标
/**
 * 字段同义词。加新平台就在这里补一行 —— 不要在平台配置里各写一套，
 * 那样「粉丝数」会有十二种叫法，改一处漏十一处。
 */
const FIELDS = {
  followers: [
    'follower_count', 'followerCount', 'followers', 'followers_count', 'fansCount', 'fans_count',
    'fans', 'fansNum', 'subscriberCount', 'subscriber_count', 'subscribers', 'totalFans',
    'total_fans', 'followerNum', 'fansTotal', 'newFans', 'mpsetting_fans', 'userFans'
  ],
  totalReads: [
    'total_read', 'totalReads', 'total_read_count', 'readCount', 'read_count', 'views',
    'viewCount', 'view_count', 'playCount', 'play_count', 'play_num', 'totalPlay',
    'total_view_count', 'totalViews', 'impressionsTotal'
  ],
  totalLikes: [
    'total_like', 'totalLikes', 'likeCount', 'like_count', 'likes', 'likedCount',
    'totalLike', 'likeNum', 'praiseCount', 'totalPraise'
  ],
  worksTotal: [
    'workCount', 'work_count', 'works', 'worksCount', 'noteCount', 'note_count', 'notes',
    'videoCount', 'video_count', 'videos', 'postCount', 'post_count', 'posts',
    'contentCount', 'content_count', 'awemeCount', 'itemCount'
  ]
};

/** 中文标签：页面文本兜底用。顺序即优先级。 */
const LABELS = {
  // 「总用户数」是公众号后台的说法，指的就是累计关注人数
  followers: ['总粉丝数', '粉丝总数', '粉丝数', '总用户数', '用户总数', '总粉丝', '粉丝', '关注者', '订阅者', 'fans'],
  totalReads: ['总阅读数', '总阅读', '累计阅读', '阅读数', '播放量', '总播放', '浏览量', '总浏览量', '观看次数'],
  totalLikes: ['总点赞', '获赞数', '获赞', '累计点赞', '点赞数', '总赞'],
  worksTotal: ['作品总数', '作品数', '内容总数', '内容数', '笔记数', '视频数', '投稿数', '发布数']
};

/** 从 JSON 里找标量字段 */
function findInJson(blobs, keys, { maxDepth = 9 } = {}) {
  const want = new Set(keys.map((k) => k.toLowerCase()));
  for (const blob of blobs) {
    let hit = null;
    bfsWalk(
      blob,
      (v, d, path) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return;
        for (const k of Object.keys(v)) {
          if (!want.has(k.toLowerCase())) continue;
          const num = toNum(v[k]);
          if (num == null) continue;
          // 别人的对象里出现同名字段 —— 记下来但先不采用，除非没有别的
          const suspicious = OTHERS.test(path);
          if (!hit || (hit.suspicious && !suspicious)) hit = { value: num, key: k, path, suspicious };
          if (!suspicious) return true;
        }
        return undefined;
      },
      { maxDepth }
    );
    if (hit && !hit.suspicious) return hit;
  }
  return null;
}

/**
 * 从页面文本里按标签取数。
 * 兼容三种排布：「粉丝 1.2万」「粉丝\n1.2万」「1.2万 粉丝」
 */
function findInText(text, labels) {
  if (!text) return null;
  const clean = String(text).replace(/\u00a0/g, ' ');
  // 「昨日阅读」不是总阅读量。不带这个否定，累计值会被日增量顶掉，
  // 曲线看着像断崖 —— 这类错最难发现，因为数字本身是真的。
  const pre = '(?<!昨日|今日|昨天|今天|本周|本月|近7天|近30天|当日|当天)';
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 标签在前。允许跨一个换行（"粉丝数\n1.2万" 是最常见的排布），
    // 但只允许一个 —— 允许两个就会把下一段的数字误认成粉丝数。
    const a = new RegExp(
      `${pre}${esc}(?:[^\\d\\n]{0,6}\\n)?[^\\d\\n]{0,8}?([\\d][\\d.,]*\\s*(?:亿|万|千|w|W|k|K)?)`,
      'i'
    );
    let m = a.exec(clean);
    if (m) {
      const n = toNum(m[1]);
      if (n != null) return { value: n, by: `文本「${label}」` };
    }
    // 数字在前（"1.2万粉丝"）
    const b = new RegExp(`([\\d][\\d.,]*\\s*(?:亿|万|千|w|W|k|K)?)[^\\d\\n]{0,4}?${esc}`, 'i');
    m = b.exec(clean);
    if (m) {
      const n = toNum(m[1]);
      if (n != null) return { value: n, by: `文本「${label}」前置` };
    }
  }
  return null;
}

/**
 * 账号级指标。三通道合并，冲突时按可信度取：
 * 接口 > 全局状态 > 页面文本（文本会有「和昨天比 +3」这种干扰）
 */
function extractAccount({ jsonBlobs = [], pageText = '', globals = {} }) {
  const out = {};
  const source = {};

  for (const field of Object.keys(FIELDS)) {
    let v = findInJson(jsonBlobs, FIELDS[field]);
    let by = v ? `接口 ${v.key}` : '';

    if (!v || v.value == null) {
      const g = findInJson([globals], FIELDS[field]);
      if (g) {
        v = g;
        by = `页面状态 ${g.key}`;
      }
    }
    if (!v || v.value == null) {
      const t = findInText(pageText, LABELS[field]);
      if (t) {
        v = t;
        by = t.by;
      }
    }
    if (v && v.value != null) {
      out[field] = v.value;
      source[field] = by;
    }
  }

  return { values: out, source };
}

// ------------------------------------------------------------ 作品
/** 作品 id 类键 */
const ID_KEYS = [
  'id', 'noteId', 'note_id', 'itemId', 'item_id', 'aweme_id', 'awemeId', 'videoId', 'video_id',
  'bvid', 'aid', 'cid', 'postId', 'post_id', 'objectId', 'object_id', 'mid', 'articleId',
  'article_id', 'tweetId', 'tweet_id', 'rest_id', 'pk', 'contentId', 'content_id', 'msgid'
];

/** 标题类键 —— 越靠前越像「标题」 */
const TITLE_KEYS = [
  'title', 'noteTitle', 'note_title', 'desc', 'caption', 'content', 'text', 'summary',
  'itemTitle', 'videoTitle', 'headline', 'excerpt'
];

/** 发布时间类键 */
const TIME_KEYS = [
  'createTime', 'create_time', 'publishTime', 'publish_time', 'publishedAt', 'published_at',
  'pubTime', 'pub_time', 'postTime', 'post_time', 'createdAt', 'created_at', 'publishDate',
  'taken_at', 'takenAt', 'timestamp', 'releaseTime'
];

/** 单条作品的指标键 */
const WORK_FIELDS = {
  reads: ['readCount', 'read_count', 'playCount', 'play_count', 'viewCount', 'view_count', 'views', 'play', 'read', 'vv', 'impressionCount', 'readNum', 'plays'],
  likes: ['likeCount', 'like_count', 'likes', 'diggCount', 'digg_count', 'praiseCount', 'praise_count', 'attitudes_count', 'likeNum', 'favoriteCount2'],
  saves: ['collectCount', 'collect_count', 'collects', 'favorites', 'favoriteCount', 'favorite_count', 'saves', 'savedCount', 'bookmarkCount', 'fav_count', 'favCount', 'collected_count'],
  comments: ['commentCount', 'comment_count', 'comments', 'replyCount', 'reply_count', 'commentNum'],
  shares: ['shareCount', 'share_count', 'shares', 'forwardCount', 'forward_count', 'repostCount', 'repost_count', 'retweetCount', 'reposts'],
  completion: ['completionRate', 'completion_rate', 'finishRate', 'finish_rate', 'playFinishRate', 'completion', 'avgCompletion'],
  newFollowers: ['newFollowerCount', 'newFollower', 'followCount', 'follow_count', 'fansIncrease', 'fans_inc', 'subscribeCount']
};

function pickKey(obj, keys) {
  const lower = new Map();
  for (const k of Object.keys(obj)) lower.set(k.toLowerCase(), k);
  for (const want of keys) {
    const real = lower.get(want.toLowerCase());
    if (real !== undefined) {
      const val = obj[real];
      if (val !== null && val !== undefined && val !== '') return { key: real, value: val };
    }
  }
  return null;
}

/** 这条对象像不像「一个作品」—— 打分，太低就不算 */
function scoreWorkItem(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return -1;
  let s = 0;
  if (pickKey(o, ID_KEYS)) s += 3;
  if (pickKey(o, TITLE_KEYS)) s += 2;
  let metrics = 0;
  for (const k of Object.keys(WORK_FIELDS)) if (pickKey(o, WORK_FIELDS[k])) metrics++;
  if (metrics >= 2) s += 2;
  else if (metrics === 1) s += 1;
  if (pickKey(o, TIME_KEYS)) s += 2;
  return s;
}

/**
 * 找出作品数组。返回 { path, items } 或 null。
 * 判据不只是「像作品」，还要「像列表」：同一种结构重复出现。
 */
function findWorkArray(blobs) {
  let best = null;
  for (const blob of blobs) {
    bfsWalk(
      blob,
      (v, d, path) => {
        if (!Array.isArray(v) || v.length < 1) return;
        if (OTHERS.test(path)) return;
        const sample = v.slice(0, 12).filter((x) => x && typeof x === 'object');
        if (sample.length < Math.min(v.length, 2)) return;
        const scores = sample.map(scoreWorkItem);
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        if (avg < 6) return;
        // 数组越长越可能真，但 2000 条以上多半是缓存全量，也收
        const score = avg * 10 + Math.min(v.length, 100) * 0.1 - d;
        if (!best || score > best.score) best = { path, items: v, score, avg };
      },
      { maxDepth: 7 }
    );
  }
  return best;
}

function titleOf(o) {
  const hit = pickKey(o, TITLE_KEYS);
  if (!hit) return '';
  const v = hit.value;
  if (typeof v === 'string') return v.trim().slice(0, 300);
  if (v && typeof v === 'object') {
    // 有些平台标题是 { text: '...' } 或富文本段落
    if (typeof v.text === 'string') return v.text.trim().slice(0, 300);
    if (Array.isArray(v)) {
      const t = v.map((x) => (x && (x.text || x.content)) || '').join('');
      if (t) return t.trim().slice(0, 300);
    }
  }
  return '';
}

/** 把一条接口对象翻成统一作品结构。认不出 id 的直接丢（否则每次刷新都会重复建行） */
function toWork(o) {
  const idHit = pickKey(o, ID_KEYS);
  if (!idHit) return null;
  const platWorkId = String(idHit.value).slice(0, 80);
  if (!platWorkId || platWorkId === '0') return null;

  const w = { platWorkId, title: titleOf(o), publishedAt: '' };

  const timeHit = pickKey(o, TIME_KEYS);
  if (timeHit) w.publishedAt = toDate(timeHit.value);

  for (const field of Object.keys(WORK_FIELDS)) {
    const hit = pickKey(o, WORK_FIELDS[field]);
    if (!hit) continue;
    const num = field === 'completion' ? toPct(hit.value) : toNum(hit.value);
    if (num != null) w[field] = num;
  }

  // 平台独有指标：数值型的都收，但排除已经归到标准字段的键
  const used = new Set(Object.keys(w).map((k) => k.toLowerCase()));
  const extra = {};
  for (const [k, v] of Object.entries(o)) {
    if (used.has(k.toLowerCase())) continue;
    if (typeof v !== 'number' && typeof v !== 'string') continue;
    if (/^(id|.*_?id|uid|mid|url|cover|link|href)$/i.test(k)) continue;
    const n = toNum(v);
    if (n == null) continue;
    if (n > 1e12) continue; // 时间戳之类
    extra[k] = n;
    if (Object.keys(extra).length >= 12) break;
  }
  if (Object.keys(extra).length) w.extra = extra;

  return w;
}

/** 作者对象与它的 id 字段 */
const AUTHOR_KEYS = ['author', 'user', 'owner', 'creator', 'account', 'authorInfo', 'userInfo', 'author_info', 'user_info'];
const AUTHOR_ID_KEYS = ['id', 'uid', 'userId', 'user_id', 'sec_uid', 'secUid', 'mid'];

/**
 * 这条内容是不是别人的。
 *
 * 必须挡这个：后台页里经常混着「推荐 / 热门 / 站方公告」，
 * 那些条目字段齐全、看着跟作品一模一样，一旦入库就变成「我发过这篇」。
 * 用户不会去核对标题，只会奇怪自己的数据怎么多了几条。
 *
 * 判据保守：只有「明确写了作者 id，且和自己不一样」才判为别人的。
 * 没写作者的一律放过 —— 宁可偶尔多读，也不要把用户自己的作品丢掉。
 */
function belongsToOther(o, ownerUid) {
  if (!ownerUid) return false;
  const a = pickKey(o, AUTHOR_KEYS);
  if (!a || !a.value || typeof a.value !== 'object') return false;
  const id = pickKey(a.value, AUTHOR_ID_KEYS);
  if (!id) return false;
  const v = String(id.value == null ? '' : id.value).trim();
  if (!v) return false;
  return v !== String(ownerUid).trim();
}

/**
 * 作品列表路径是否可信。
 *
 * 平台后台的接口名通常带 list / item / note / post 这类词。
 * 反过来，单纯叫 `data`、`result` 的数组，多半是「首页信息流」——
 * 里面混着推荐内容和站方公告。
 */
const TRUSTED_PATH = /(list|item|work|note|post|video|article|status|publish|content|media|aweme|appmsg|feed_?item|creations?)/i;

/** 从原料里抽作品列表 */
function extractWorks({ jsonBlobs = [], globals = {}, ownerUid = '' }) {
  const found = findWorkArray(jsonBlobs) || findWorkArray([globals]);
  if (!found) return { works: [], path: '' };

  const seen = new Set();
  const works = [];
  for (const o of found.items) {
    if (belongsToOther(o, ownerUid)) continue;
    const w = toWork(o);
    if (!w || seen.has(w.platWorkId)) continue;
    seen.add(w.platWorkId);
    works.push(w);
  }

  // 一道必要的闸：路径名很泛、且一条互动指标都没有 —— 那不是作品列表，是信息流。
  // 这种情况宁愿报「没读到作品」，也不能把别人的文章写进「我发过的内容」。
  const hasMetrics = works.some(
    (w) => w.reads != null || w.likes != null || w.comments != null || w.saves != null || w.shares != null
  );
  if (works.length && !hasMetrics && !TRUSTED_PATH.test(found.path)) {
    return { works: [], path: `${found.path}（判为信息流，已丢弃）` };
  }

  return { works, path: found.path };
}

// ------------------------------------------------------------ 身份
/**
 * 昵称 / handle / uid。
 *
 * 这里最容易被「同名不同义」坑到：接口里到处都有 name 字段，
 * 上报对象的 name 可能是 'js_error'，配置项的 name 可能是 'default'。
 * 所以分两档：
 *   严格档（nickname / display_name）—— 名字本身就说明是昵称，直接用
 *   宽松档（name / username）—— 必须同时出现在一个「看起来像用户」的对象里才认
 */
const NICK_STRICT = ['nickname', 'nickName', 'nick_name', 'displayName', 'display_name', 'channelTitle', 'authorName', 'author_name'];
const NICK_LOOSE = ['name', 'userName', 'user_name', 'screen_name'];
const HANDLE_KEYS = ['handle', 'screenName', 'uniqueId', 'unique_id', 'accountName', 'shortId', 'custom_handle'];
const UID_KEYS = ['uid', 'userId', 'user_id', 'sec_uid', 'secUid', 'channelId', 'channel_id', 'redId', 'red_id', 'buvid'];

/** 一个对象里有这些键，才可能是「用户对象」 */
const USER_HINTS = new Set([
  'avatar', 'avatarurl', 'avatar_url', 'avatarbig', 'avatarlarge', 'avatarthumb', 'avatarmedium',
  'uniqueid', 'unique_id', 'uid', 'userid', 'user_id', 'secuid', 'sec_uid', 'signature', 'bio',
  'followercount', 'follower_count', 'fanscount', 'awemecount', 'aweme_count', 'followingcount',
  'following_count', 'nickname', 'profile', 'description'
]);

/** 明显不是人名的值：上报字段名、占位符、纯标点。 */
const NOT_A_NAME = /^(js_|undefined|null|true|false|object|string|number|default|unknown|admin_?\d*$)/i;

/** 人名的样子：至少有两个字符，且不全是标点/符号 */
function looksLikeName(v) {
  const s = String(v || '').trim();
  if (s.length < 2 || s.length > 60) return false;
  if (NOT_A_NAME.test(s)) return false;
  if (/^[\p{P}\p{S}\s]+$/u.test(s)) return false;
  return true;
}

function isUserShape(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  for (const k of Object.keys(o)) if (USER_HINTS.has(k.toLowerCase())) return true;
  return false;
}

function extractIdentity({ jsonBlobs = [], pageText = '', globals = {}, plat = '' }) {
  const out = { nickname: '', handle: '', uid: '' };

  const blob = globals.__INITIAL_STATE__ || globals.__NEXT_DATA__ || (jsonBlobs.length === 1 ? jsonBlobs[0] : null);

  const hunt = (keys, opts) => {
    const hit = findInJsonStr(jsonBlobs, keys, opts) || (blob ? findInJsonStr([blob], keys, opts) : null);
    return hit ? hit.value : '';
  };

  // 昵称：先严格档，不要求对象形状；再宽松档，必须像用户对象
  out.nickname = String(hunt(NICK_STRICT) || '').slice(0, 60);
  if (!out.nickname) {
    out.nickname = String(hunt(NICK_LOOSE, { requireUserShape: true }) || '').slice(0, 60);
  }

  out.handle = String(hunt(HANDLE_KEYS, { requireUserShape: true }) || '').slice(0, 60);
  out.uid = String(hunt(UID_KEYS, { requireUserShape: true }) || '').slice(0, 60);

  // 页面文本兜底：取前几行里最像「名字」的一行
  if (!out.nickname && pageText) {
    const lines = pageText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    // 昵称在页面上通常出现两次以上（顶栏 + 内容区），导航项只出现一次。
    // 靠这一条能把「草稿箱」「数据分析」这类菜单项挡掉 —— 光靠关键词永远列不全。
    const counts = new Map();
    for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1);

    for (const line of lines.slice(0, 40)) {
      if (line.length < 2 || line.length > 20) continue;
      if (/^\d/.test(line)) continue;
      if (NAV_WORDS.test(line)) continue;
      if (NOT_A_NAME.test(line)) continue;
      if ((counts.get(line) || 0) < 2) continue;
      out.nickname = line;
      break;
    }
  }
  return out;
}

/** 后台导航与动作词。昵称兜底时用它挡掉菜单项。 */
const NAV_WORDS =
  /登录|注册|首页|工作台|数据中心|数据分析|创作|管理|设置|帮助|草稿|素材|发表|记录|互动|留言|私信|评论|收益|变现|赞赏|广告|小店|账号|菜单|搜索|通知|新的功能|全部|暂无|关于|服务协议|规则|客服|反馈|版权|原创|合集|视频|直播|文章|贴图|播客|转载|选择已有|前往|立即|查看|详情|更多|导出|下载|上传|保存|提交|取消|确认|返回|退出|充值|提现|实名|绑定|授权|同步|刷新|加载|共\d|第\d/;

/** 字符串标量查找（昵称用） */
function findInJsonStr(blobs, keys, { requireUserShape = false } = {}) {
  const want = new Set(keys.map((k) => k.toLowerCase()));
  for (const b of blobs) {
    let hit = null;
    bfsWalk(
      b,
      (v, d, path) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return;
        if (OTHERS.test(path)) return;
        // 宽松档：要求这个对象里有用户特征键，否则 `{name:'js_error'}` 也会被当成昵称
        if (requireUserShape && !isUserShape(v)) return;
        for (const k of Object.keys(v)) {
          if (!want.has(k.toLowerCase())) continue;
          const val = v[k];
          if (typeof val !== 'string') continue;
          if (!looksLikeName(val)) continue;
          if (!hit || d < hit.depth) hit = { value: val.trim(), key: k, depth: d };
          if (d === 0) return true;
        }
        return undefined;
      },
      { maxDepth: 6 }
    );
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------------------ 链接
/**
 * 从页面链接里取身份与粉丝数。
 *
 * 这一条是给 X / Instagram 用的：它们的接口里全是「别人的用户对象」，
 * 只有个人主页上 `a[href="/handle/followers"]` 那个链接的文本才是自己的数字。
 * 从接口猜，会稳定地读到某个推荐大V的粉丝数 —— 数字真实但属于别人，
 * 这种错最难发现，所以对这类平台宁可只认 DOM。
 */
function extractFromLinks(links = []) {
  const out = { followers: null, handle: '', following: null };
  for (const l of links) {
    const href = String((l && l.href) || '');
    const text = String((l && l.text) || '').replace(/\s+/g, ' ').trim();

    const m = /^\/([A-Za-z0-9_.]{2,30})\/(?:verified_)?(followers|following)$/i.exec(href);
    if (!m) continue;

    const n = toNum(text.replace(/\s*(followers?|following|粉丝|关注者|正在关注)$/i, ''));
    if (n == null) continue;

    if (/followers/i.test(m[2])) {
      if (!out.handle) out.handle = m[1];
      if (out.followers == null) out.followers = n;
    } else if (out.following == null) {
      out.following = n;
    }
  }
  return out;
}

/**
 * 页面是不是明确说「没有作品」。
 * 这条很重要：账号指标读到了、作品列表是空的，有两种完全不同的原因 ——
 * 一种是「这个号确实还没发过东西」，一种是「列表没认出来」。
 * 前者是有效事实（可以写 0），后者是数据不全（不能写 0）。
 */
const EMPTY_WORKS = /(暂无作品|暂无发表|暂无内容|暂无笔记|暂无视频|还没有作品|还没有发布|还没有内容|共\s*0\s*条|0\s*条作品)/;

function looksNoWorks(pageText) {
  return EMPTY_WORKS.test(String(pageText || ''));
}

// ------------------------------------------------------------ 登录墙
const LOGIN_WALL = /(扫码登录|密码登录|验证码登录|登录后查看|请先登录|登录\/注册|立即登录|Sign in to|Log in to|登录以继续|账号登录)/;

/**
 * 这个页面是不是「要求登录」。
 * 判据要严：数据页底部也可能有「登录」两个字（页脚），
 * 所以看的是「整页几乎没有数字指标 + 出现了登录字样」。
 */
function looksLoginWall(pageText, accountValues) {
  if (accountValues && Object.keys(accountValues).length) return false;
  const t = String(pageText || '');
  if (!t.trim()) return false; // 空白页不等于登录墙，交给 empty 处理
  return LOGIN_WALL.test(t.slice(0, 4000));
}

module.exports = {
  toNum,
  toPct,
  toDate,
  bfsWalk,
  findInJson,
  findInText,
  extractAccount,
  extractWorks,
  extractIdentity,
  extractFromLinks,
  looksNoWorks,
  looksLoginWall,
  scoreWorkItem,
  toWork,
  FIELDS,
  LABELS,
  WORK_FIELDS
};
