'use strict';
/**
 * 每个平台「该看什么」
 *
 * 为什么必须有这个文件：
 *   十二个平台的「作品」根本不是同一种东西。
 *   公众号一篇是长文，抖音一条是 15 秒视频，X 一条可能是三个字，
 *   B站一个稿件带弹幕和投币，视频号能看完播率。
 *   拿同一套指标（阅读/赞/评/享）去衡量全部，等于用体重衡量身高 ——
 *   数字都有，但比出来的结论是错的。
 *
 * 所以每个平台声明三件事：
 *   focus  —— 主指标：这个平台的成败主要由哪一个数决定，界面默认就显示它
 *   cards  —— 指标卡：最上面那排显示什么（顺序就是重要性顺序）
 *   angle  —— 分析角度：看这个平台时该问什么问题、算法上侧重什么
 *
 * `angle` 里只写**能算出来的**，不写「要关注内容质量」这种废话。
 */

/**
 * 通用指标卡定义。值是「怎么从 works + snapshots 算出来」。
 * 这里只描述，不含求值逻辑 —— 求值在 ui/charts.js，因为它要用 fmt 等界面工具。
 */
const CARD = {
  followers: { k: '粉丝', how: 'latest.followers' },
  works: { k: '作品', how: 'works.length' },
  reads: { k: '阅读', how: 'sum.reads', win: true },
  plays: { k: '播放', how: 'sum.reads', win: true },
  views: { k: '查看', how: 'sum.reads' },
  likes: { k: '赞', how: 'sum.likes' },
  comments: { k: '评论', how: 'sum.comments' },
  shares: { k: '分享', how: 'sum.shares' },
  saves: { k: '收藏', how: 'sum.saves' },
  coins: { k: '投币', how: 'sum.extra.coins' },
  danmaku: { k: '弹幕', how: 'sum.extra.danmaku' },
  completion: { k: '完播率', how: 'avg.completion', unit: '%' },
  quotes: { k: '引用', how: 'sum.extra.quotes' },
  recommend: { k: '推荐', how: 'sum.extra.recommend' },
  interRate: { k: '互动率', how: 'ratio.inter', unit: '%' },
  perWork: { k: '篇均阅读', how: 'avg.reads' }
};

const PLAT_PROFILE = {
  公众号: {
    focus: 'reads',
    focusWhy: '长文的成败就在读完的人有多少；分享多说明值得转发，是这个平台最强的信号',
    cards: ['followers', 'works', 'reads', 'shares', 'interRate'],
    angle: {
      // 「分享」是公众号最有意义的互动：愿意转到朋友圈，说明内容真的有用
      primary: 'shares',
      note: '分享率（分享 ÷ 阅读）比点赞更能说明内容好不好 —— 点赞是一秒钟的事，转发要担人情',
      // 只在公众号看的指标
      only: ['shares', 'recommend']
    }
  },

  小红书: {
    focus: 'reads',
    focusWhy: '首页推荐决定了曝光，先有观看才有后面的一切（平台总览是近 7 天口径）',
    cards: ['followers', 'works', 'reads', 'saves', 'interRate'],
    angle: {
      primary: 'saves',
      note: '收藏率是小红书的核心信号：先收藏再行动，收藏高说明是「有用的笔记」',
      only: ['saves']
    }
  },

  抖音: {
    focus: 'reads',
    focusWhy: '播放量决定能不能进下一级流量池（平台总览是近 7 天口径）',
    cards: ['followers', 'works', 'plays', 'likes', 'interRate'],
    angle: {
      primary: 'likes',
      // 抖音的完播率拿不到（创作者后台列表不返回），所以侧重点赞率
      note: '点赞率最能反映「划到之后有没有看下去」；评论多说明引发了争议或共鸣',
      only: []
    }
  },

  视频号: {
    focus: 'reads',
    focusWhy: '播放是基础，但完播率才是视频号特有的「有没有看完」',
    cards: ['followers', 'works', 'plays', 'completion', 'interRate'],
    angle: {
      primary: 'completion',
      note: '完播率是视频号独有的指标：低于 20% 说明前 3 秒没抓住人，跟播放量高低无关',
      only: ['completion']
    }
  },

  微博: {
    focus: 'reads',
    focusWhy: '阅读靠推荐和转发扩散，单条波动极大，更适合看「哪类话题能扩散」',
    cards: ['followers', 'works', 'reads', 'shares', 'interRate'],
    angle: {
      primary: 'shares',
      note: '转发是微博的传播单位；转发远高于点赞说明这条被当成了「消息」而不是「观点」',
      only: ['shares']
    }
  },

  知乎: {
    focus: 'reads',
    focusWhy: '长答案的阅读靠推荐流和时间累积，越老的答案可能阅读越高',
    cards: ['followers', 'works', 'reads', 'likes', 'interRate'],
    angle: {
      primary: 'likes',
      note: '赞同率反映「说得对不对」；收藏高说明是「工具型内容」，会被反复回看',
      only: ['saves']
    }
  },

  B站: {
    focus: 'reads',
    focusWhy: '播放决定推荐权重；投币和收藏是 B站特有的「愿意为它付出」',
    cards: ['followers', 'works', 'plays', 'coins', 'interRate'],
    angle: {
      primary: 'coins',
      note: '投币要花自己的币，是 B站最强的认可信号；弹幕多说明有共鸣点可以反复看',
      only: ['coins', 'danmaku']
    }
  },

  X: {
    focus: 'reads',
    focusWhy: '查看次数是 X 最有价值的指标 —— 平台自己就是按它算触达的',
    cards: ['followers', 'works', 'views', 'likes', 'quotes', 'interRate'],
    angle: {
      primary: 'quotes',
      note: '引用比转发更能说明「值得加一句自己的话」；原创、回复、转发要分开看，混在一起算平均值没意义',
      only: ['quotes', 'bookmarks']
    }
  },

  YouTube: {
    focus: 'reads',
    focusWhy: '观看次数决定推荐；但订阅转化才说明内容留住了人',
    cards: ['followers', 'works', 'plays', 'likes', 'interRate'],
    angle: {
      primary: 'likes',
      note: '点赞率配合观看时长看才有意义；只有观看数会高估「划过去就算看过」的内容',
      only: []
    }
  },

  Instagram: {
    focus: 'reads',
    focusWhy: '播放（视频）和查看是两种口径，图文没有播放数',
    cards: ['followers', 'works', 'reads', 'likes', 'saves', 'interRate'],
    angle: {
      primary: 'saves',
      note: '收藏是 IG 最实的信号：愿意存下来再看一遍；个人号拿不到触达和展示',
      only: ['saves']
    }
  },

  Threads: {
    focus: 'reads',
    focusWhy: '浏览数只有专业账号才有；没有就退回看互动率',
    cards: ['followers', 'works', 'reads', 'likes', 'interRate'],
    angle: {
      primary: 'comments',
      note: 'Threads 是对话型产品，回复数比点赞更能说明引发了讨论',
      only: ['comments']
    }
  },

  TikTok: {
    focus: 'reads',
    focusWhy: '播放量是算法推荐的结果；主页只给播放，赞和评论要进每条视频才有',
    cards: ['followers', 'works', 'plays', 'interRate'],
    angle: {
      primary: 'reads',
      note: '同一条视频的播放会在几天里持续涨；拿发布当天的数字和一周后的比，会得出相反的结论',
      only: []
    }
  }
};

/** 拿不到 profile 的平台退回一套通用值，不要让界面崩 */
const FALLBACK = {
  readLabel: '阅读',
  focus: 'reads',
  focusWhy: '',
  cards: ['followers', 'works', 'reads', 'likes', 'interRate'],
  angle: { primary: 'likes', note: '', only: [] }
};

/**
 * 「reads」这个字段在不同平台叫法不同，界面必须跟着改口。
 * 把 148 次播放印成「阅读」，用户会以为是文章阅读量。
 */
const READ_LABEL = {
  Instagram: '播放',
  抖音: '播放',
  B站: '播放',
  视频号: '播放',
  YouTube: '观看',
  X: '查看',
  小红书: '观看',
  Threads: '浏览',
  公众号: '阅读',
  知乎: '阅读',
  微博: '阅读',
  TikTok: '播放'
};

function profileOf(plat) {
  const p = PLAT_PROFILE[plat];
  if (!p) return Object.assign({}, FALLBACK, { readLabel: READ_LABEL[plat] || '阅读' });
  return {
    focus: p.focus,
    focusWhy: p.focusWhy,
    cards: p.cards.slice(),
    readLabel: READ_LABEL[plat] || '阅读',
    angle: {
      primary: p.angle.primary,
      note: p.angle.note,
      only: (p.angle.only || []).slice()
    }
  };
}

module.exports = { PLAT_PROFILE, FALLBACK, CARD, READ_LABEL, profileOf };
