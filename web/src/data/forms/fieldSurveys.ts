import type { Schema } from '../schemas'

// 现场表精确录入版式（S1/S4 补建的10张现场表，AI读PDF原件逐张还原）
// 生成自 示例《系统流程》原件；CEMS(461/561)数据对差=B-A 自动算，其余统计/条件公式暂手填

const field133: Schema = {
  id: 'field133',
  title: () => "红外分光光度法测油烟原始记录表",
  columns: [], meta: [], signRoles: ["检验", "复核", "审核"],
  seed: () => [],
  layout: [
    {
      "type": "table",
      "id": "main",
      "columns": [
        {
          "key": "no",
          "label": "样品编号",
          "kind": "id",
          "w": 110
        },
        {
          "key": "V",
          "label": "定容体积",
          "unit": "ml",
          "kind": "input"
        },
        {
          "key": "K",
          "label": "萃取液稀释倍数K",
          "kind": "input"
        },
        {
          "key": "a2930",
          "label": "A2930",
          "kind": "input"
        },
        {
          "key": "a2960",
          "label": "A2960",
          "kind": "input"
        },
        {
          "key": "a3030",
          "label": "A3030",
          "kind": "input"
        },
        {
          "key": "rho",
          "label": "含量ρ",
          "unit": "mg/L",
          "kind": "input"
        },
        {
          "key": "v0",
          "label": "标准状态下干烟气采样体积V0",
          "unit": "m³",
          "kind": "input"
        },
        {
          "key": "conc",
          "label": "浓度",
          "unit": "mg/m³",
          "kind": "input"
        },
        {
          "key": "nd",
          "label": "标杆流量Nd",
          "unit": "m³/h",
          "kind": "input"
        },
        {
          "key": "rate",
          "label": "油烟排放速率",
          "unit": "kg/h",
          "kind": "input"
        },
        {
          "key": "remark",
          "label": "备注",
          "kind": "input",
          "w": 90
        }
      ],
      "seedRows": 10
    },
    {
      "type": "kv",
      "id": "info",
      "cols": 2,
      "rows": [
        {
          "label": "测量项目",
          "fixed": true,
          "value": "饮食业油烟"
        },
        {
          "label": "仪器型号",
          "fixed": true,
          "value": "JKY-3A 红外测油仪"
        },
        {
          "label": "测量方法",
          "fixed": true,
          "value": "饮食业油烟排放标准（试行）红外分光光度法"
        },
        {
          "label": "方法依据",
          "fixed": true,
          "value": "GB 18483-2001"
        },
        {
          "label": "光程",
          "fixed": true,
          "value": "40mm"
        },
        {
          "label": "油烟含量计算公式",
          "fixed": true,
          "value": "ρ=[X*A2930+Y*A2960+Z(A3030- A2930/F)]×V1×K/V",
          "latex": "\\rho=\\left[X\\cdot A_{2930}+Y\\cdot A_{2960}+Z\\left(A_{3030}-\\frac{A_{2930}}{F}\\right)\\right]\\times\\frac{V_1\\times K}{V}"
        },
        {
          "label": "系数",
          "fixed": true,
          "value": "X=42.6469  Y=55.585  Z=317.5495  F=38.7074"
        },
        {
          "label": "测量日期",
          "key": "measureDate"
        }
      ]
    }
  ],
}

const field141: Schema = {
  id: 'field141',
  title: () => "现场信息调查表",
  columns: [], meta: [], signRoles: ["采样", "复核", "审核"],
  seed: () => [],
  layout: [
    {
      "type": "kv",
      "id": "top",
      "cols": 1,
      "rows": [
        {
          "label": "项目编号",
          "key": "projectNo"
        }
      ]
    },
    {
      "type": "kv",
      "id": "org",
      "cols": 2,
      "rows": [
        {
          "label": "受检单位名称",
          "key": "orgName"
        },
        {
          "label": "企业签字确认",
          "key": "orgSign"
        },
        {
          "label": "受检单位地址",
          "key": "orgAddr"
        },
        {
          "label": "联系电话",
          "key": "phone"
        },
        {
          "label": "采样日期",
          "key": "sampleDate"
        }
      ]
    },
    {
      "type": "table",
      "id": "main",
      "columns": [
        {
          "key": "stack",
          "label": "排气筒名称",
          "kind": "input",
          "w": 120
        },
        {
          "key": "items",
          "label": "检测项目",
          "kind": "input",
          "w": 180
        },
        {
          "key": "model",
          "label": "设备/锅炉型号",
          "kind": "input"
        },
        {
          "key": "cap",
          "label": "锅炉容量",
          "unit": "t/h",
          "kind": "input"
        },
        {
          "key": "pos",
          "label": "采样位置",
          "kind": "input"
        },
        {
          "key": "treat",
          "label": "废气处理工艺",
          "kind": "input",
          "w": 140
        },
        {
          "key": "fuel",
          "label": "燃料种类",
          "kind": "input"
        },
        {
          "key": "height",
          "label": "烟囱高度",
          "unit": "m",
          "kind": "input"
        },
        {
          "key": "section",
          "label": "烟道截面积(内径)",
          "unit": "m²/m",
          "kind": "input"
        },
        {
          "key": "remark",
          "label": "备注",
          "kind": "input",
          "w": 80
        }
      ],
      "seedRows": 12
    }
  ],
}

const field147: Schema = {
  id: 'field147',
  title: () => "采样参数记录表",
  columns: [], meta: [], signRoles: ["采样", "复核", "审核"],
  seed: () => [],
  layout: [
    {
      "type": "kv",
      "id": "top",
      "cols": 1,
      "rows": [
        {
          "label": "项目编号",
          "key": "projectNo"
        }
      ]
    },
    {
      "type": "table",
      "id": "main",
      "columns": [
        {
          "key": "sampleDate",
          "label": "采样日期",
          "kind": "input",
          "w": 100
        },
        {
          "key": "org",
          "label": "单位名称",
          "kind": "input",
          "w": 200
        },
        {
          "key": "time",
          "label": "时间",
          "kind": "input",
          "w": 80
        },
        {
          "key": "point",
          "label": "点位",
          "kind": "input",
          "w": 70
        },
        {
          "key": "totalCloud",
          "label": "总云量",
          "kind": "input",
          "w": 70
        },
        {
          "key": "lowCloud",
          "label": "低云量",
          "kind": "input",
          "w": 70
        },
        {
          "key": "windSpeed",
          "label": "风速",
          "unit": "m/s",
          "kind": "input",
          "w": 80
        },
        {
          "key": "windDir",
          "label": "风向",
          "kind": "input",
          "w": 80
        },
        {
          "key": "pressure",
          "label": "气压",
          "unit": "kPa",
          "kind": "input",
          "w": 80
        },
        {
          "key": "temp",
          "label": "温度",
          "unit": "℃",
          "kind": "input",
          "w": 80
        },
        {
          "key": "remark",
          "label": "备注",
          "kind": "input",
          "w": 90
        }
      ],
      "seedRows": 18
    }
  ],
}

const field461: Schema = {
  id: 'field461',
  title: () => "烟气连续在线监测系统（CEMS）比对/验收监测运算记录(I)",
  columns: [], meta: [], signRoles: ["检验", "复核", "审核"],
  seed: () => [],
  compute: (row) => { const n=(v:any)=>(v===''||v==null||isNaN(+v)?null:+v); const d=(a:any,b:any)=>{const x=n(a),y=n(b);return x==null||y==null?null:+(y-x).toFixed(3)}; return { so2Diff:d(row.so2Manual,row.so2Cems), noxDiff:d(row.noxManual,row.noxCems), o2Diff:d(row.o2Manual,row.o2Cems) }; },
  layout: [
    {
      "type": "kv",
      "id": "top",
      "cols": 3,
      "rows": [
        {
          "label": "项目名称",
          "key": "projectName"
        },
        {
          "label": "测试位置",
          "key": "testLocation"
        },
        {
          "label": "测试日期",
          "key": "testDate"
        }
      ]
    },
    {
      "type": "kv",
      "id": "units",
      "cols": 3,
      "rows": [
        {
          "label": "SO₂单位",
          "key": "so2Unit"
        },
        {
          "label": "NOx单位",
          "key": "noxUnit"
        },
        {
          "label": "含氧量单位",
          "fixed": true,
          "value": "%"
        }
      ]
    },
    {
      "type": "table",
      "id": "main",
      "columns": [
        {
          "key": "no",
          "label": "编号",
          "kind": "id",
          "w": 60
        },
        {
          "key": "time",
          "label": "监测时间（或时间段）",
          "kind": "input",
          "w": 150
        },
        {
          "key": "so2Manual",
          "label": "SO₂ 手工数据(A)",
          "kind": "input",
          "w": 90
        },
        {
          "key": "so2Cems",
          "label": "SO₂ CEMS数据(B)",
          "kind": "input",
          "w": 90
        },
        {
          "key": "so2Diff",
          "label": "SO₂ 数据对差(B-A)",
          "kind": "auto",
          "w": 90
        },
        {
          "key": "noxManual",
          "label": "NOx 手工数据(A)",
          "kind": "input",
          "w": 90
        },
        {
          "key": "noxCems",
          "label": "NOx CEMS数据(B)",
          "kind": "input",
          "w": 90
        },
        {
          "key": "noxDiff",
          "label": "NOx 数据对差(B-A)",
          "kind": "auto",
          "w": 90
        },
        {
          "key": "o2Manual",
          "label": "含氧量 手工数据(A)",
          "kind": "input",
          "w": 90
        },
        {
          "key": "o2Cems",
          "label": "含氧量 CEMS数据(B)",
          "kind": "input",
          "w": 90
        },
        {
          "key": "o2Diff",
          "label": "含氧量 数据对差(B-A)",
          "kind": "auto",
          "w": 90
        }
      ],
      "seedRows": 9
    },
    {
      "type": "matrix",
      "id": "stats",
      "transpose": true,
      "rowHeaders": [
        {
          "label": "平均值",
          "key": "avg"
        },
        {
          "label": "绝对误差",
          "key": "absErr"
        },
        {
          "label": "相对误差（%）",
          "key": "relErr"
        },
        {
          "label": "相对准确度（%）",
          "key": "relAccuracy"
        }
      ],
      "colHeaders": [
        {
          "label": "SO₂",
          "key": "so2"
        },
        {
          "label": "NOx",
          "key": "nox"
        },
        {
          "label": "含氧量",
          "key": "o2"
        }
      ],
      "cellKind": "input",
      "note": "各比对项目的统计运算结果，由上表9组数据推算。"
    },
    {
      "type": "note",
      "id": "remark",
      "label": "备注",
      "key": "remark",
      "rows": 3
    }
  ],
}

const field561: Schema = {
  id: 'field561',
  title: () => "烟气连续在线监测系统(CEMS)比对/验收监测运算记录(I)",
  columns: [], meta: [], signRoles: ["检验", "复核", "审核"],
  seed: () => [],
  compute: (row) => { const n=(v:any)=>(v===''||v==null||isNaN(+v)?null:+v); const d=(a:any,b:any)=>{const x=n(a),y=n(b);return x==null||y==null?null:+(y-x).toFixed(3)}; return { p1_diff:d(row.p1_manual,row.p1_cems), p2_diff:d(row.p2_manual,row.p2_cems), p3_diff:d(row.p3_manual,row.p3_cems) }; },
  layout: [
    {
      "type": "kv",
      "id": "top",
      "cols": 3,
      "rows": [
        {
          "label": "项目名称",
          "key": "proj"
        },
        {
          "label": "测试位置",
          "key": "loc"
        },
        {
          "label": "测试日期",
          "key": "date"
        }
      ]
    },
    {
      "type": "kv",
      "id": "items",
      "cols": 2,
      "rows": [
        {
          "label": "比对项目1",
          "key": "item1"
        },
        {
          "label": "单位1",
          "key": "unit1"
        },
        {
          "label": "比对项目2",
          "key": "item2"
        },
        {
          "label": "单位2",
          "key": "unit2"
        },
        {
          "label": "比对项目3",
          "key": "item3"
        },
        {
          "label": "单位3",
          "key": "unit3"
        }
      ]
    },
    {
      "type": "table",
      "id": "main",
      "columns": [
        {
          "key": "no",
          "label": "编号",
          "kind": "id",
          "w": 60
        },
        {
          "key": "time",
          "label": "监测时间(或时间段)",
          "kind": "input",
          "w": 140
        },
        {
          "key": "p1_manual",
          "label": "比对项目1 手工数据(A)",
          "kind": "input"
        },
        {
          "key": "p1_cems",
          "label": "比对项目1 CEMS数据(B)",
          "kind": "input"
        },
        {
          "key": "p1_diff",
          "label": "比对项目1 数据对差(B-A)",
          "kind": "auto"
        },
        {
          "key": "p2_manual",
          "label": "比对项目2 手工数据(A)",
          "kind": "input"
        },
        {
          "key": "p2_cems",
          "label": "比对项目2 CEMS数据(B)",
          "kind": "input"
        },
        {
          "key": "p2_diff",
          "label": "比对项目2 数据对差(B-A)",
          "kind": "auto"
        },
        {
          "key": "p3_manual",
          "label": "比对项目3 手工数据(A)",
          "kind": "input"
        },
        {
          "key": "p3_cems",
          "label": "比对项目3 CEMS数据(B)",
          "kind": "input"
        },
        {
          "key": "p3_diff",
          "label": "比对项目3 数据对差(B-A)",
          "kind": "auto"
        }
      ],
      "seedRows": 9
    },
    {
      "type": "matrix",
      "id": "stats",
      "transpose": true,
      "rowHeaders": [
        {
          "label": "平均值",
          "key": "avg"
        },
        {
          "label": "绝对误差",
          "key": "abs_err"
        },
        {
          "label": "相对误差(%)",
          "key": "rel_err"
        },
        {
          "label": "相对准确度(%)",
          "key": "rel_acc"
        }
      ],
      "colHeaders": [
        {
          "label": "比对项目1",
          "key": "p1"
        },
        {
          "label": "比对项目2",
          "key": "p2"
        },
        {
          "label": "比对项目3",
          "key": "p3"
        }
      ],
      "cellKind": "input",
      "note": "各比对项目的统计结果按对应列数据自动计算"
    },
    {
      "type": "note",
      "id": "remark",
      "label": "备注",
      "key": "remark",
      "rows": 3
    }
  ],
}

const field564: Schema = {
  id: 'field564',
  title: () => "区域声环境监测记录表",
  columns: [], meta: [], signRoles: ["采样", "复核", "审核"],
  seed: () => [],
  layout: [
    {
      "type": "kv",
      "id": "top",
      "cols": 2,
      "rows": [
        {
          "label": "噪声仪(型号/编号)",
          "key": "meter"
        },
        {
          "label": "声校准器(型号/编号)",
          "key": "calibrator"
        },
        {
          "label": "监测前校准值 dB",
          "key": "cal_before"
        },
        {
          "label": "监测后校准值 dB",
          "key": "cal_after"
        },
        {
          "label": "气象风速条件",
          "key": "weather"
        }
      ]
    },
    {
      "type": "table",
      "id": "main",
      "columns": [
        {
          "key": "grid",
          "label": "网格代码",
          "kind": "input",
          "w": 70
        },
        {
          "key": "point",
          "label": "测点名称",
          "kind": "input",
          "w": 130
        },
        {
          "key": "month",
          "label": "月",
          "kind": "input",
          "w": 40
        },
        {
          "key": "day",
          "label": "日",
          "kind": "input",
          "w": 40
        },
        {
          "key": "start",
          "label": "开始时/分",
          "kind": "input",
          "w": 70
        },
        {
          "key": "end",
          "label": "结束时/分",
          "kind": "input",
          "w": 70
        },
        {
          "key": "src",
          "label": "声源代码",
          "kind": "input",
          "w": 60
        },
        {
          "key": "leq",
          "label": "Leq",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "sd",
          "label": "(SD)",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "lmax",
          "label": "Lmax",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "lmin",
          "label": "Lmin",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "l90",
          "label": "L90",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "l50",
          "label": "L50",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "l10",
          "label": "L10",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "remark",
          "label": "备注",
          "kind": "input",
          "w": 100
        }
      ],
      "seedRows": 16
    },
    {
      "type": "kv",
      "id": "method",
      "cols": 1,
      "rows": [
        {
          "label": "测量方法",
          "fixed": true,
          "value": "HJ 640-2012"
        },
        {
          "label": "方法依据",
          "fixed": true,
          "value": "环境噪声监测技术规范 城市声环境常规监测"
        }
      ]
    },
    {
      "type": "kv",
      "id": "src_note",
      "cols": 1,
      "rows": [
        {
          "label": "注(声源代码)",
          "fixed": true,
          "value": "声源代码:1、交通噪声; 2、工业噪声; 3、施工噪声; 4、生活噪声。两种以上噪声填主噪声。除交通、工业、施工噪声外的噪声,归入生活噪声。"
        }
      ]
    }
  ],
}

const field605: Schema = {
  id: 'field605',
  title: () => "加油站基本情况调查表",
  columns: [], meta: [], signRoles: ["检测人员", "加油站陪检人"],
  seed: () => [],
  layout: [
    {
      "type": "kv",
      "id": "station",
      "cols": 2,
      "rows": [
        {
          "label": "加油站名称",
          "key": "org"
        },
        {
          "label": "加油站地址",
          "key": "addr"
        },
        {
          "label": "联系人",
          "key": "contact"
        },
        {
          "label": "联系电话",
          "key": "phone"
        }
      ]
    },
    {
      "type": "kv",
      "id": "recovery",
      "cols": 2,
      "rows": [
        {
          "label": "加油机品牌",
          "key": "pump_brand"
        },
        {
          "label": "加油机型号",
          "key": "pump_model"
        },
        {
          "label": "加油机数量",
          "key": "pump_qty"
        },
        {
          "label": "加油枪品牌",
          "key": "gun_brand"
        },
        {
          "label": "加油枪型号",
          "key": "gun_model"
        },
        {
          "label": "档位",
          "checks": [
            "两档",
            "三档"
          ],
          "checksKey": "gun_gear"
        },
        {
          "label": "加油枪数量",
          "key": "gun_qty"
        },
        {
          "label": "真空泵品牌",
          "key": "vac_brand"
        },
        {
          "label": "真空泵型号",
          "key": "vac_model"
        },
        {
          "label": "方式",
          "checks": [
            "集中式",
            "分散式"
          ],
          "checksKey": "vac_mode"
        },
        {
          "label": "真空泵数量",
          "key": "vac_qty"
        }
      ]
    },
    {
      "type": "kv",
      "id": "reformer",
      "cols": 1,
      "rows": [
        {
          "label": "加油机供货商",
          "key": "supplier"
        },
        {
          "label": "管线改造商",
          "key": "pipe_reformer"
        }
      ]
    },
    {
      "type": "kv",
      "id": "result",
      "cols": 1,
      "rows": [
        {
          "label": "油气回收治理厂家",
          "key": "treat_maker"
        },
        {
          "label": "三次油气回收系统装置",
          "key": "tertiary_dev"
        },
        {
          "label": "在线监控装置",
          "key": "online_monitor"
        },
        {
          "label": "是否有合格的自检报告",
          "checks": [
            "是",
            "否"
          ],
          "checksKey": "self_report"
        },
        {
          "label": "检测合格与否",
          "checks": [
            "是",
            "否"
          ],
          "checksKey": "qualified"
        },
        {
          "label": "是否为复检",
          "checks": [
            "是",
            "否"
          ],
          "checksKey": "is_recheck"
        },
        {
          "label": "检测人员",
          "key": "tester"
        },
        {
          "label": "加油站陪检人",
          "key": "accompanier"
        },
        {
          "label": "检测日期",
          "key": "test_date"
        }
      ]
    },
    {
      "type": "diagram",
      "id": "plan",
      "label": "加油站平面图"
    }
  ],
}

const field609: Schema = {
  id: 'field609',
  title: () => "油气回收现场信息调查表",
  columns: [], meta: [], signRoles: ["采样", "复核", "审核"],
  seed: () => [],
  layout: [
    {
      "type": "kv",
      "id": "top",
      "cols": 2,
      "rows": [
        {
          "label": "项目编号",
          "key": "proj_no"
        },
        {
          "label": "受检单位名称",
          "key": "org"
        },
        {
          "label": "企业签字确认",
          "key": "org_sign"
        },
        {
          "label": "受检单位地址",
          "key": "addr"
        },
        {
          "label": "联系电话",
          "key": "phone"
        },
        {
          "label": "采样日期",
          "key": "sample_date"
        }
      ]
    },
    {
      "type": "table",
      "id": "main",
      "columns": [
        {
          "key": "point",
          "label": "监测点位",
          "kind": "input",
          "w": 120
        },
        {
          "key": "item",
          "label": "检测项目",
          "kind": "input"
        },
        {
          "key": "dev_model",
          "label": "处理装置型号",
          "kind": "input"
        },
        {
          "key": "dev_maker",
          "label": "处理装置厂家名称",
          "kind": "input"
        },
        {
          "key": "dev_qty",
          "label": "处理装置数量",
          "kind": "input",
          "w": 80
        },
        {
          "key": "process",
          "label": "处理工艺",
          "kind": "input"
        },
        {
          "key": "remark",
          "label": "备注",
          "kind": "input",
          "w": 80
        }
      ],
      "seedRows": 12
    }
  ],
}

const field632: Schema = {
  id: 'field632',
  title: () => "现场信息调查表",
  columns: [], meta: [], signRoles: ["采样", "复核", "审核"],
  seed: () => [],
  layout: [
    {
      "type": "kv",
      "id": "top",
      "cols": 2,
      "rows": [
        {
          "label": "委托单位名称",
          "key": "org"
        },
        {
          "label": "项目编号",
          "key": "projectNo"
        },
        {
          "label": "受检单位名称",
          "key": "inspectedOrg"
        },
        {
          "label": "联系电话",
          "key": "phone"
        },
        {
          "label": "受检单位地址",
          "key": "address"
        }
      ]
    },
    {
      "type": "kv",
      "id": "confirm",
      "cols": 1,
      "rows": [
        {
          "label": "我确认以下点位生产工况正常",
          "fixed": true,
          "value": "我确认以下点位生产工况正常"
        }
      ]
    },
    {
      "type": "table",
      "id": "main",
      "columns": [
        {
          "key": "point",
          "label": "点位名称",
          "kind": "input",
          "w": 120
        },
        {
          "key": "item",
          "label": "检测项目",
          "kind": "input",
          "w": 150
        },
        {
          "key": "model",
          "label": "设备/锅炉型号",
          "kind": "input"
        },
        {
          "key": "capacity",
          "label": "锅炉容量",
          "unit": "t/h",
          "kind": "input"
        },
        {
          "key": "pos",
          "label": "采样位置",
          "kind": "input"
        },
        {
          "key": "process",
          "label": "废气处理工艺",
          "kind": "input"
        },
        {
          "key": "fuel",
          "label": "燃料种类",
          "kind": "input"
        },
        {
          "key": "stackH",
          "label": "烟囱高度",
          "unit": "m",
          "kind": "input"
        },
        {
          "key": "stackD",
          "label": "排气筒内径",
          "unit": "m",
          "kind": "input"
        },
        {
          "key": "remark",
          "label": "备注",
          "kind": "input"
        }
      ],
      "seedRows": 10
    },
    {
      "type": "kv",
      "id": "date",
      "cols": 1,
      "rows": [
        {
          "label": "采样日期",
          "key": "sampleDate"
        }
      ]
    }
  ],
}

const field710: Schema = {
  id: 'field710',
  title: () => "污泥采样记录表",
  columns: [], meta: [], signRoles: ["采样", "复核", "审核"],
  seed: () => [],
  layout: [
    {
      "type": "kv",
      "id": "top",
      "cols": 1,
      "rows": [
        {
          "label": "受检单位",
          "key": "inspectedOrg"
        }
      ]
    },
    {
      "type": "table",
      "id": "main",
      "columns": [
        {
          "key": "no",
          "label": "序号",
          "kind": "id",
          "w": 60
        },
        {
          "key": "sampleNo",
          "label": "样品编号",
          "kind": "input"
        },
        {
          "key": "point",
          "label": "采样点位",
          "kind": "input"
        },
        {
          "key": "item",
          "label": "检测项目",
          "kind": "input",
          "w": 150
        },
        {
          "key": "container",
          "label": "采样容器",
          "kind": "input"
        },
        {
          "key": "descOdor",
          "label": "样品描述-嗅味",
          "kind": "input"
        },
        {
          "key": "descColor",
          "label": "样品描述-颜色",
          "kind": "input"
        },
        {
          "key": "descWet",
          "label": "样品描述-潮湿",
          "kind": "input"
        },
        {
          "key": "descOther",
          "label": "样品描述-其他",
          "kind": "input"
        },
        {
          "key": "bio",
          "label": "生物状况",
          "kind": "input"
        },
        {
          "key": "remark",
          "label": "备注",
          "kind": "input"
        }
      ],
      "seedRows": 12
    }
  ],
}

const field733: Schema = {
  id: 'field733',
  title: () => "铁路边界噪声检测原始记录",
  columns: [], meta: [], signRoles: ["采样", "复核", "审核"],
  seed: () => [],
  layout: [
    {
      "type": "kv",
      "id": "top",
      "cols": 2,
      "rows": [
        {
          "label": "测量日期",
          "key": "date"
        },
        {
          "label": "天气情况、风速",
          "key": "weather"
        },
        {
          "label": "线路股数",
          "key": "tracks"
        },
        {
          "label": "车流密度（辆/小时）",
          "key": "traffic"
        },
        {
          "label": "距离轨面距离m",
          "key": "railDist"
        }
      ]
    },
    {
      "type": "table",
      "id": "main",
      "columns": [
        {
          "key": "point",
          "label": "测点名称",
          "kind": "id",
          "w": 110
        },
        {
          "key": "time",
          "label": "测量时间",
          "kind": "input"
        },
        {
          "key": "source",
          "label": "声源",
          "kind": "input"
        },
        {
          "key": "leq",
          "label": "Leq",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "leqOut",
          "label": "报出Leq",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "l10",
          "label": "L10",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "l50",
          "label": "L50",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "l90",
          "label": "L90",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "lmax",
          "label": "Lmax",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "lmin",
          "label": "Lmin",
          "unit": "dB",
          "kind": "input"
        },
        {
          "key": "sd",
          "label": "SD",
          "kind": "input"
        }
      ],
      "seedRows": 10
    },
    {
      "type": "kv",
      "id": "bottom",
      "cols": 2,
      "rows": [
        {
          "label": "背景值修正参考",
          "fixed": true,
          "value": "差值3→修正-3；差值4-5→修正-2；差值6-9→修正-1"
        },
        {
          "label": "背景值",
          "key": "bg"
        },
        {
          "label": "校准器测量前dB",
          "key": "calBefore"
        },
        {
          "label": "校准器测量后dB",
          "key": "calAfter"
        },
        {
          "label": "测点与轨道间地面状况",
          "key": "ground"
        },
        {
          "label": "仪器型号或编号",
          "key": "instrument"
        },
        {
          "label": "校准器型号或编号",
          "key": "calibrator"
        },
        {
          "label": "检测方法",
          "fixed": true,
          "value": "GB 12525-1990 铁路边界噪声限值及其测量方法（含修改单）"
        }
      ]
    },
    {
      "type": "diagram",
      "id": "diag",
      "label": "示意图"
    }
  ],
}

export const fieldSurveyForms: Record<string, Schema> = {
  'HJ-TC-133': field133,
  'HJ-TC-141': field141,
  'HJ-TC-147': field147,
  'HJ-TC-461': field461,
  'HJ-TC-561': field561,
  'HJ-TC-564': field564,
  'HJ-TC-605': field605,
  'HJ-TC-609': field609,
  'HJ-TC-632': field632,
  'HJ-TC-710': field710,
  'HJ-TC-733': field733,
}
