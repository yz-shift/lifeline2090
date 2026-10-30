// Shared constants. Import from here instead of re-declaring.

export const FIRST_YEAR = 2000;
export const HISTORY_END = 2026;      // years <= HISTORY_END use real history (2026 partially, up to the data date)
export const LAST_YEAR = 2090;        // world model horizon; lives may continue past it with frozen 2090 conditions
export const DATA_DATE = '2026-10-24';
export const MAX_AGE = 115;

export const STATS = ['health', 'happiness', 'knowledge', 'relationships', 'wealth'];
export const STAT_LABELS = { health: '健康', happiness: '快乐', knowledge: '知识', relationships: '人际', wealth: '财富' };

export const REGIONS = {
  EAS: '东亚', SEA: '东南亚', SAS: '南亚', CAS: '中亚', WAS: '西亚与中东', NAF: '北非',
  SSA: '撒哈拉以南非洲', EEU: '东欧', WEU: '西欧、北欧与南欧', NAM: '北美', LAC: '拉丁美洲与加勒比', OCE: '大洋洲',
};

// income group thresholds on GDP per capita, PPP constant 2021 intl $ (approximate mapping of WB Atlas thresholds)
export const INCOME_THRESHOLDS = [
  { id: 'LIC', max: 2600, label: '低收入' },
  { id: 'LMC', max: 9000, label: '中低收入' },
  { id: 'UMC', max: 26000, label: '中高收入' },
  { id: 'HIC', max: Infinity, label: '高收入' },
];

// Standard decision moments (age); the engine may add triggered decisions in between.
export const DECISION_AGES = [5, 12, 15, 18, 22, 26, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
export const DECISION_FREQUENCY = {
  sparse: [5, 15, 18, 22, 30, 40, 50, 60, 70, 80, 90],  // close to the original game's rhythm
  standard: DECISION_AGES,
  frequent: null, // engine: every 2-3 years from age 5
};

export const EDU_LEVELS = ['none', 'preschool', 'primary', 'secondary', 'vocational', 'tertiary', 'postgrad'];
export const EDU_LABELS = { none: '未上学', preschool: '学前', primary: '小学', secondary: '中学', vocational: '职业教育', tertiary: '大学', postgrad: '研究生' };

export const CAREER_STATUS = ['child', 'student', 'employed', 'self_employed', 'unemployed', 'homemaker', 'military', 'retired', 'unable'];
export const CAREER_LABELS = { child: '儿童', student: '学生', employed: '受雇', self_employed: '自雇/创业', unemployed: '失业', homemaker: '操持家务', military: '服役', retired: '退休', unable: '无法工作' };

export const RELATIONSHIP_LABELS = { single: '单身', dating: '恋爱中', married: '已婚', partnered: '同居伴侣', divorced: '离异', widowed: '丧偶' };

// Life-map cell tags (one per lived year, dominant theme). UI maps each to a colour token.
export const YEAR_TAGS = ['birth', 'childhood', 'study', 'work', 'love', 'family', 'loss', 'illness', 'crisis', 'war', 'migration', 'success', 'calm', 'retire', 'death'];
export const YEAR_TAG_LABELS = {
  birth: '出生', childhood: '童年', study: '求学', work: '工作', love: '爱情', family: '家庭', loss: '失去', illness: '疾病',
  crisis: '危机', war: '战乱', migration: '迁徙', success: '高光', calm: '平静', retire: '退休', death: '离世',
};

export const AI_MODES = { off: '关闭（内置推演引擎）', quick: '快速', default: '标准', complex: '深度' };

export const LIFE_LENGTH_OPTIONS = [
  { minutes: 10, label: '10 分钟' }, { minutes: 30, label: '30 分钟' },
  { minutes: 60, label: '1 小时' }, { minutes: 90, label: '1.5 小时' },
];

export const STORAGE_KEYS = {
  current: 'll2090.current',     // in-progress life (autosave each year)
  past: 'll2090.past',           // last 10 finished lives
  settings: 'll2090.settings',
  stats: 'll2090.lifetime',      // achievements / counters
};
export const PAST_LIVES_MAX = 10;

export const clamp = (x, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));
