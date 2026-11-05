export interface Agent {
  id: string
  code: string
  name: string
  master: string
  avatar: string
  tags: string[]
  skills: number
  price: number
  rating: number
  tasks: number
  industry: string
}

export const AGENTS: Agent[] = [
  {
    id: 'zhenheng',
    code: 'ART-0007',
    name: '振衡',
    master: '陈国栋 · 32年数控经验',
    avatar: '/avatar-zhenheng.png',
    tags: ['振动诊断', '动平衡校正', '故障预测'],
    skills: 24,
    price: 660,
    rating: 4.9,
    tasks: 1842,
    industry: '装备制造',
  },
  {
    id: 'tingtao',
    code: 'ART-0012',
    name: '听涛',
    master: '林慧敏 · 27年声学检测',
    avatar: '/avatar-tingtao.png',
    tags: ['声学检测', '异音定位', '频谱分析'],
    skills: 18,
    price: 660,
    rating: 4.8,
    tasks: 1204,
    industry: '汽车零部件',
  },
  {
    id: 'chimou',
    code: 'ART-0019',
    name: '炽眸',
    master: '赵云霞 · 29年焊接工艺',
    avatar: '/avatar-chimou.png',
    tags: ['焊缝质检', '缺陷识别', '工艺优化'],
    skills: 21,
    price: 660,
    rating: 4.9,
    tasks: 1567,
    industry: '压力容器',
  },
  {
    id: 'hengzhun',
    code: 'ART-0025',
    name: '衡准',
    master: '周守拙 · 35年精密测量',
    avatar: '/avatar-hengzhun.png',
    tags: ['精密测量', '公差分析', 'SPC 管控'],
    skills: 26,
    price: 660,
    rating: 5.0,
    tasks: 2103,
    industry: '精密仪器',
  },
  {
    id: 'celu',
    code: 'ART-0031',
    name: '策炉',
    master: '霍炎彬 · 30年热处理',
    avatar: '/avatar-celu.png',
    tags: ['热处理曲线', '淬火控制', '金相分析'],
    skills: 19,
    price: 660,
    rating: 4.7,
    tasks: 986,
    industry: '模具钢加工',
  },
  {
    id: 'xunxian',
    code: 'ART-0038',
    name: '巡线',
    master: '秦望舒 · 24年产线管理',
    avatar: '/avatar-xunxian.png',
    tags: ['产线巡检', '节拍优化', '异常上报'],
    skills: 16,
    price: 660,
    rating: 4.6,
    tasks: 1730,
    industry: '电子装配',
  },
]
