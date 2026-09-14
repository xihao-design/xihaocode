import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "XihaoUC",
  description: "A VitePress Site",
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: '🏠首页', link: '/' },
      { text: '🔍指南', link: '/markdown-examples' },
      { text: '📚资源',
        items: [
          { text: '📱 宝藏软件', link: '/pages/good-software' },
          { text: '👨‍🎨 设计创意', link: '/pages/crossborder-resources' },
          { text: '🎓 教育资源', link: '/pages/edu-resources' },
          { text: '🤖 AI工具', link: '/pages/ai-resources' },
          { text: '📚 书籍资料', link: '/pages/book-resources' },
          { text: '📰 自媒体副业', link: '/pages/selfmedia-resources' },
          { text: '💼 职场资源', link: '/pages/course-resources' },
          { text: '🏞️ 精选壁纸', link: '/pages/audiovisual-resources' },
          { text: '🎮 游戏资源', link: '/pages/game-resources' },
          ]
      }
      ],

    sidebar: [
      {
        text: '使用指南',
        items: [
          { text: '本站介绍', link: '/markdown-examples' },
          { text: '如何获取', link: '/api-examples' }
        ]
      },
      {
        text: '全部资源',
        items: [
          { text: '宝藏软件资源', link: '/pages/good-software' },
          { text: '设计创意', link: '/pages/crossborder-resources' },
          { text: '教育资源', link: '/pages/edu-resources' },
          { text: 'AI工具资源', link: '/pages/ai-resources' },
          { text: '书籍资料', link: '/pages/book-resources' },
          { text: '自媒体运营', link: '/pages/selfmedia-resources' },
          { text: '职场资源', link: '/pages/course-resources' },
          { text: '精选壁纸', link: '/pages/audiovisual-resources' },
          { text: '游戏资源', link: '/pages/game-resources' }
        ]
      }
    ],

    // 左上角 logo
    logo: '/logo.png',


     //本地搜索
    search: { 
      provider: 'local'
    }, 

     outline: { 
      level: [2,4], // 显示2-4级标题
      // level: 'deep', // 显示2-6级标题
      label: '当前页大纲' // 文字显示
    },

     //返回顶部文字修改
    returnToTopLabel:'返回顶部',

     //侧边栏文字更改(移动端)
    sidebarMenuLabel:'目录', 

    //自定义社交链接 
    socialLinks: [
      {
        icon: {
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M17.2809 2.95549C20.2499 3.1584 21.0363 5.29655 21.1199 5.5524L22.4167 5.64758C22.5466 5.64758 22.5858 5.82844 22.471 5.88421C21.148 6.60011 20.7438 8.05479 20.9814 9.00236C21.071 9.35974 21.2346 9.69179 21.3932 10.0224C21.6998 10.6637 22.0441 11.4403 22.1003 13.0033C22.2168 16.2423 19.5895 19.1778 16.3115 19.5956C17.4813 18.4088 18.1256 17.1518 18.4313 16.2207C19.0373 14.375 18.9393 12.9046 18.4857 11.781C18.0385 10.6732 17.2806 9.98965 16.7036 9.63988C15.021 8.62006 13.4846 8.54938 12.2604 8.878C12.7253 8.28379 13.1361 7.6768 13.4596 7.01357C14.0436 5.36416 13.3581 4.1657 12.7563 3.49525C12.5642 3.24941 12.695 2.83984 13.0607 2.83984C14.4703 2.83984 15.8737 2.8604 17.2809 2.95549ZM3.31872 19.1067C5.24275 16.9048 8.0315 13.7133 10.4814 10.9564C11.04 10.3277 13.2499 8.61858 16.2285 10.424C17.1068 10.9564 18.6589 12.589 17.5605 15.9349C16.7576 18.3804 13.1532 23.7301 1.80115 21.7784C1.5741 21.7394 1.29 21.4242 1.58312 21.0905C1.99794 20.6183 2.59759 19.932 3.31872 19.1067Z"></path></svg>'
        },
        link: 'https://www.yuque.com/xihaouc',
        // You can include a custom label for accessibility too (optional but recommended):
        ariaLabel: '我的主页'
      }
    ], 

    //页脚
    footer: { 
      message: '<a href="https://beian.miit.gov.cn/#/Integrated/index" target="_blank" rel="noopener noreferrer">鲁ICP备2025193604号</a>', 
      copyright: 'Copyright © 2025-2027 All Rights Reserved.', 
      // 自动更新时间
      //copyright: `Copyright © 2019-${new Date().getFullYear()} present Evan You`, 
    }, 

  },

  //fav图标
  head: [
    ['link',{ rel: 'icon', href: '/logo.png'}],
  ],

})
