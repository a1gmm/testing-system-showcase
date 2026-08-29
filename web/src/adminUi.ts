import type { App } from 'vue'
import { ElButton,ElDialog,ElIcon,ElInput,ElLoading,ElOption,ElPagination,ElSelect,ElSelectV2,ElTag } from 'element-plus'
import { ArrowRight,Box,Calendar,Checked,CircleCheck,Close,Cpu,DataAnalysis,Document,Edit,EditPen,Files,Finished,Folder,Grid,Lock,MagicStick,Odometer,OfficeBuilding,Position,Postcard,Printer,Search,Share,User } from '@element-plus/icons-vue'
import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/el-button.css'
import 'element-plus/theme-chalk/el-dialog.css'
import 'element-plus/theme-chalk/el-icon.css'
import 'element-plus/theme-chalk/el-input.css'
import 'element-plus/theme-chalk/el-message.css'
import 'element-plus/theme-chalk/el-message-box.css'
import 'element-plus/theme-chalk/el-loading.css'
import 'element-plus/theme-chalk/el-option.css'
import 'element-plus/theme-chalk/el-overlay.css'
import 'element-plus/theme-chalk/el-pagination.css'
import 'element-plus/theme-chalk/el-popper.css'
import 'element-plus/theme-chalk/el-scrollbar.css'
import 'element-plus/theme-chalk/el-select.css'
import 'element-plus/theme-chalk/el-select-v2.css'
import 'element-plus/theme-chalk/el-tag.css'
import './admin-font.css'

const components={ElButton,ElDialog,ElIcon,ElInput,ElOption,ElPagination,ElSelect,ElSelectV2,ElTag}
const icons={ArrowRight,Box,Calendar,Checked,CircleCheck,Close,Cpu,DataAnalysis,Document,Edit,EditPen,Files,Finished,Folder,Grid,Lock,MagicStick,Odometer,OfficeBuilding,Position,Postcard,Printer,Search,Share,User}
const installedApps=new WeakSet<App>()
export function installAdminUi(app:App){if(installedApps.has(app))return;installedApps.add(app);if(typeof document!=='undefined')document.documentElement.classList.add('admin-ui');for(const component of Object.values(components))app.component(component.name!,component);for(const[name,icon]of Object.entries(icons))app.component(name,icon);app.directive('loading', ElLoading.directive)}
