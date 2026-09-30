import '../utils/logger';
import {cleanupLogger} from '../utils/logger';
import {XAuthClient} from "./utils";
import {getUserIdentity} from './user-identity';
import path from 'path';
import fs from "fs-extra";
import {get} from 'lodash';
import dayjs from "dayjs";
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

// 配置时区插件
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ_BEIJING = 'Asia/Shanghai';

const FOLLOWING_DATA_PATH = path.resolve(__dirname, '../data/followingUser.json');
const LAST_UPDATED_PATH = path.resolve(__dirname, '../data/updatedInfo.txt');
const UPDATE_INTERVAL_HOURS = 6;

export async function processHomeTimeline() {
    console.log(`----- ----- ----- ----- fetch-following begin ----- ----- ----- -----`);
    try {
        const client = await XAuthClient();

        const screenName = process.env.SCREEN_NAME;
        if (!screenName) {
            throw new Error("❌ SCREEN_NAME 环境变量未配置");
        }
        console.log(`🌐 正在请求API获取用户信息：@${screenName}`);
        const response = await client.getUserApi().getUserByScreenName({screenName});
        if (!response.data?.user?.restId) {
            throw new Error(`❌ 用户 @${screenName} 存在但无法获取有效ID`);
        }
        // 用户自身信息
        const userSelf = response.data.user;
        const userId = userSelf.restId;

        const timestamp = dayjs().format('YYYYMMDD-HHmmss');
        const rawOutputPath = path.join(__dirname, '../resp/respFollowing', `${timestamp}.json`);
        fs.ensureDirSync(path.dirname(rawOutputPath));

        let cursor: string | undefined;
        let allUsers = [];
        let pageCount = 0;
        let emptyCount = 0;
        const requestInterval = 5000;

        do {
            pageCount++;
            console.log(`\n=== 第 ${pageCount} 次请求 ===`);

            // 添加间隔控制（第一页后生效）
            if (pageCount > 1) {
                console.log(`⏸️ 等待 ${requestInterval / 1000} 秒...`);
                await new Promise(r => setTimeout(r, requestInterval));
            }

            const resp = await client.getUserListApi().getFollowing({
                userId,
                cursor,
                count: 20
            });
            if (!resp?.data?.data || !Array.isArray(resp.data.data)) {
                throw new Error("DATA_INVALID: 用户列表数据格式错误");
            }

            // 提取有效用户数据
            const rawItems = get(resp, 'data.data', []);
            const currentCursor = get(resp, 'data.cursor.bottom.value', null);

            // 转换数据结构
            const validUsers = rawItems
                .map(item => get(item, 'user', null))
                .filter(user => user && typeof user === 'object');  // 过滤无效用户

            if (validUsers.length === 0) {
                emptyCount++;
                console.log(`⚠️ 空响应计数: ${emptyCount}/3`);
                if (emptyCount >= 3) {
                    console.log("⏹️ 终止原因：连续3次空响应");
                    break;
                }
            } else {
                emptyCount = 0; // 重置计数器
                allUsers.push(...validUsers);
            }

            // 更新游标
            cursor = currentCursor;
            console.log(`✅ 获取到 ${validUsers.length} 用户 | 游标: ${cursor || '无'}`);

        } while (true); // 改为由内部条件控制

        // 数据写入
        await fs.writeFile(rawOutputPath, JSON.stringify(allUsers, null, 2));
        console.log(`\n🎉 完成！共获取 ${allUsers.length} 个用户`);

        allUsers.unshift(userSelf);
        console.log(`\n➕ 添加用户自身信息 @${getUserIdentity(userSelf).screenName || screenName}`);
        console.log(`\n🛠️ 开始精简用户数据...`);

        const simplifiedUsers = allUsers.map(simplifyUser);

        console.log(`🔄 按 screenName 进行字典序排序...`);
        simplifiedUsers.sort((a, b) =>
            a.legacy.screenName.localeCompare(b.legacy.screenName)
        );

        // 确保目录存在
        fs.ensureDirSync(path.dirname(FOLLOWING_DATA_PATH));
        await fs.writeFile(FOLLOWING_DATA_PATH, JSON.stringify(simplifiedUsers, null, 2));
        console.log(`✅ 精简数据完成，已保存至: ${FOLLOWING_DATA_PATH}`);

        console.log(`🔄 正在保存更新元数据...`);
        fs.ensureDirSync(path.dirname(LAST_UPDATED_PATH));
        await fs.writeFile(LAST_UPDATED_PATH, dayjs().tz(TZ_BEIJING).format('YYYY-MM-DD HH:mm:ss'));

    } catch (error) {
        console.error('处理失败:', error.message);
        throw error;
    }
    console.log(`----- ----- ----- ----- fetch-following end ----- ----- ----- -----`);

}

export function simplifyUser(user: any) {
    const {name, screenName, createdAt} = getUserIdentity(user);
    return {
        restId: user.restId,
        legacy: {
            name,
            screenName,
            createdAt,
            description: get(user, 'legacy.description', ''),
            entities: get(user, 'legacy.entities', {}),
            profileBannerUrl: get(user, 'legacy.profileBannerUrl', ''),
            profileImageUrlHttps: get(user, 'legacy.profileImageUrlHttps', '')
        }
    };
}

async function shouldFetchNewData() {
    try {
        // 检查数据文件是否存在
        if (!await fs.pathExists(FOLLOWING_DATA_PATH)) {
            console.log('关注列表不存在');
            return true;
        }

        // 检查更新时间记录文件
        if (!await fs.pathExists(LAST_UPDATED_PATH)) {
            console.log('关注列表更新记录不存在');
            return true;
        }

        // 读取最后更新时间
        const lastUpdated = (await fs.readFile(LAST_UPDATED_PATH, 'utf8')).trim();
        // 使用北京时区解析的自定义格式
        const lastUpdatedBJ = dayjs.tz(lastUpdated, 'YYYY-MM-DD HH:mm:ss', TZ_BEIJING);
        // 计算基于北京时间的时间差
        const hoursDiff = dayjs().tz(TZ_BEIJING).diff(lastUpdatedBJ, 'hour');

        if (hoursDiff >= UPDATE_INTERVAL_HOURS) {
            console.log(`关注列表距离上次更新已过 ${hoursDiff} 小时，需要执行`);
            return true;
        }

        console.log(`关注列表距离上次更新仅 ${hoursDiff} 小时，跳过执行`);
        return false;
    } catch (error) {
        console.warn('关注列表更新条件检查异常:', error.message);
        return true;
    }
}

export async function main() {
    try {
        if (!await shouldFetchNewData()) {
            console.log('⏭️ 跳过关注列表更新流程');
            return;
        }

        await processHomeTimeline();
    } catch (error) {
        if (error.message.startsWith("DATA_INVALID")) {
            console.warn("⚠️ 数据异常，跳过处理");
        } else {
            console.error("❌ 全局异常:", error.message);
            process.exitCode = 1;
        }
    } finally {
        // 统一资源清理
        await cleanupLogger();
        process.exit();
    }
}

// 启动执行
if (import.meta.main) {
    main();
}
