// How well the offline classifier understands free-text choices: node tests/_intent_probe.mjs
import { readFileSync } from 'node:fs';
import { classifyIntent, interpretCustom, interpretLine } from '../src/core/decisions.js';
import { makeDataStore } from '../src/core/data.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
// [text, acceptable top intents]
const CASES = [
  ['我想好好学习考个好大学', ['study']], ['努力读书', ['study']], ['我要考研', ['grad']], ['去读个MBA', ['grad', 'study']],
  ['不读了，出去打工赚钱', ['drop_out', 'job_hunt']], ['复读一年再考', ['study']], ['转专业学计算机', ['change_major']],
  ['去美国读博', ['study_abroad']], ['出国留学', ['study_abroad']], ['去日本打工', ['labor_abroad', 'emigrate']],
  ['移民加拿大', ['emigrate']], ['去北京闯一闯', ['move_city']], ['去上海发展', ['move_city']], ['回老家', ['return_home']],
  ['回县城考个编制', ['civil_service']], ['考公务员', ['civil_service']], ['进体制内', ['civil_service']],
  ['跳槽去大厂', ['job_hunt']], ['换个工作', ['job_hunt']], ['辞职', ['quit_job']], ['裸辞去旅行', ['quit_job', 'travel']],
  ['去送外卖', ['gig']], ['开滴滴', ['gig']], ['自己创业', ['start_business']], ['开一家奶茶店', ['start_business']],
  ['和朋友合伙开公司', ['start_business']], ['摆地摊', ['start_business', 'side_hustle']], ['做自媒体当博主', ['side_hustle', 'artist', 'writer']],
  ['做直播带货', ['side_hustle', 'start_business']], ['努力工作争取升职', ['promotion']], ['学AI', ['learn_ai']], ['学一门手艺', ['learn_trade']],
  ['学英语', ['learn_language']], ['当医生', ['medicine']], ['当老师', ['teach']], ['回村种地', ['farming']], ['去当兵', ['military']],
  ['谈恋爱', ['date']], ['去相亲', ['date']], ['向她表白', ['date']], ['追那个喜欢的女生', ['date']], ['和女朋友结婚', ['marry']], ['求婚', ['marry']],
  ['不结婚了一个人过', ['stay_single']], ['分手', ['breakup']], ['离婚', ['divorce']], ['和前任复合', ['reconcile']], ['要个孩子', ['have_child']],
  ['生二胎', ['have_child']], ['丁克', ['childfree']], ['领养一个孩子', ['adopt']], ['多陪陪家人', ['family_time']], ['多陪孩子', ['family_time']],
  ['把爸妈接过来住', ['care_parents']], ['回家照顾生病的妈妈', ['care_parents']], ['每天跑步', ['exercise']], ['去健身房练肌肉', ['exercise']],
  ['戒烟', ['quit_smoking']], ['减肥', ['diet', 'exercise']], ['少玩手机', ['screen']], ['早睡早起', ['sleep']], ['去医院做个体检', ['health_check']],
  ['去看心理医生', ['therapy']], ['我不想活了', ['crisis']], ['信佛', ['faith']], ['去做义工', ['volunteer']], ['出去旅游散散心', ['travel']],
  ['去西藏', ['travel']], ['休息一段时间', ['rest']], ['躺平', ['rest']], ['gap一年', ['rest']], ['炒股', ['invest_stocks']], ['买基金', ['invest_stocks', 'save']],
  ['买比特币', ['invest_crypto']], ['买房', ['buy_home']], ['贷款买套房', ['buy_home']], ['攒钱', ['save']], ['存钱养老', ['save']],
  ['买彩票', ['gamble']], ['去澳门赌一把', ['gamble']], ['学画画', ['learn_hobby', 'artist']], ['组乐队', ['musician']], ['写小说', ['writer']],
  ['当职业电竞选手', ['athlete', 'artist']], ['学钢琴', ['learn_hobby']], ['提前退休', ['retire_early']], ['退休', ['retire']], ['继续干下去不退休', ['keep_working']],
  ['帮儿子带孙子', ['grandkids']], ['写回忆录', ['memoir']], ['立遗嘱', ['will']], ['住养老院', ['nursing_home']], ['参加同学聚会', ['reunion']],
  ['多交朋友', ['friends']], ['养只猫', ['pet']], ['养条狗', ['pet']], ['去太空旅行', ['space']], ['什么都不做，顺其自然', ['stay']],
  // harder, colloquial phrasings
  ['我想换个活法', ['career_change', 'move_city', 'rest']], ['卷不动了，想回老家躺着', ['return_home', 'rest']], ['好好赚钱给爸妈买房', ['promotion', 'save', 'buy_home', 'care_parents']],
  ['跟着表哥去广东进厂', ['move_city', 'job_hunt']], ['去深圳找工作', ['move_city', 'job_hunt']], ['我想当网红', ['side_hustle', 'artist']], ['考教师资格证当老师', ['teach']],
  ['先工作几年再考研', ['grad', 'job_hunt']], ['把房子卖了去大理开民宿', ['start_business']], ['送孩子出国读书', ['kid_abroad']], ['给孩子报补习班', ['kid_tutor']],
  ['学做饭', ['learn_hobby']], ['存钱结婚', ['save', 'marry']], ['去考驾照', ['learn_trade', 'study']], ['学开挖掘机', ['learn_trade']], ['去学厨师', ['learn_trade']],
  ['考个证书提升自己', ['study']], ['多读书', ['study']], ['自学编程转行做程序员', ['career_change', 'learn_ai']], ['搞副业', ['side_hustle']],
  ['跟老板提加薪', ['promotion']], ['去国企', ['civil_service', 'job_hunt']], ['好好陪老婆', ['family_time']], ['给家里寄钱', ['care_parents', 'family_time']],
  ['少喝点酒', ['diet']], ['每天冥想', ['therapy', 'rest', 'faith']], ['去徒步走川藏线', ['travel']], ['学游泳', ['exercise', 'learn_hobby']],
  ['和喜欢的人一起去看海', ['travel', 'date']], ['好好过日子', ['stay']], ['抓住这次机会', ['stay']], ['听爸妈的', ['stay']], ['再想想', ['stay', 'rest']],
];
let ok = 0, none = 0, wrong = [];
for (const [t, want] of CASES) {
  const c = classifyIntent(t, data);
  const top = c.intents[0];
  if (!top) { none++; wrong.push(`∅  ${t}`); continue; }
  if (want.includes(top)) ok++; else wrong.push(`✗  ${t}  -> ${c.intents.slice(0, 3).join(',')} (want ${want.join('/')})`);
}
console.log(`cases ${CASES.length}  correct ${ok}  not understood ${none}  wrong ${CASES.length - ok - none}`);
console.log(wrong.join('\n'));

// replies that only make sense against the decision on screen
const D = (key, opts) => ({ id: key, options: opts.map(([label, act], i) => ({ id: 'abcd'[i], label, detail: '', risk: 'mid' })),
  context: { key, acts: Object.fromEntries(opts.map(([, act], i) => ['abcd'[i], { act, p: {} }])), labels: Object.fromEntries(opts.map(([l], i) => ['abcd'[i], l])) } });
const offer = D('offer', [['接受外地的工作', 'accept_offer'], ['留在本地', 'stay_course'], ['先谈谈条件', 'promotion_push']]);
const grad = D('grad', [['考公务员', 'civil_service'], ['去大城市找工作', 'migrate_city'], ['回家乡工作', 'return_home'], ['继续读研', 'grad_school']]);
const marry = D('marry', [['听父母的去相亲', 'seek_partner'], ['再等等合适的人', 'stay_course'], ['一个人也挺好', 'stay_single']]);
const CTX = [
  [offer, '好', 'a'], [offer, '我去', 'a'], [offer, '答应他们', 'a'], [offer, '算了', 'b'], [offer, '不去了', 'b'], [offer, '选第三个', 'c'], [offer, 'C', 'c'],
  [offer, '先跟他们谈谈工资', 'c'], [offer, '还是留在本地吧', 'b'],
  [grad, '我去考编', 'a'], [grad, '考研', 'd'], [grad, '回老家上班', 'c'], [grad, '去北京找工作', 'b'], [grad, '第二个', 'b'], [grad, '读研究生', 'd'],
  [marry, '听爸妈的', 'a'], [marry, '再等等吧', 'b'], [marry, '不急，等缘分', 'b'], [marry, '我一个人过挺好', 'c'], [marry, '去相亲看看', 'a'],
];
let cok = 0; const cbad = [];
for (const [d, t, want] of CTX) {
  const it = interpretCustom(t, d, data, 'CHN');
  if (it.kind === 'option' && it.optionId === want) cok++; else cbad.push(`✗  [${d.id}] ${t} -> ${JSON.stringify(it)} (want ${want})`);
}
console.log(`\ncontext replies ${CTX.length}  correct ${cok}`);
console.log(cbad.join('\n'));
console.log(interpretLine(interpretCustom('辞职去大理开民宿', null, data)));
