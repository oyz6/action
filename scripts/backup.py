#!/usr/bin/env python3
import os
import sys
import tarfile
import requests
from datetime import datetime
from pathlib import Path
import xml.etree.ElementTree as ET

# 环境变量
REPO_TOKEN = os.environ.get('REPO_TOKEN')
WEBDAV = os.environ.get('WEBDAV')  # 格式: username-----password
TG_BOT_TOKEN = os.environ.get('TG_BOT_TOKEN')
TG_CHAT_ID = os.environ.get('TG_CHAT_ID')
WEBDAV_URL = os.environ.get('WEBDAV_URL')
REPO_NAME = os.environ.get('GITHUB_REPOSITORY', '').replace('/', '-')

MAX_BACKUPS = 5


def send_telegram_message(message):
    """发送 Telegram 通知"""
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        print("⚠️ Telegram 配置未设置，跳过通知")
        return
    
    url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage"
    data = {
        "chat_id": TG_CHAT_ID,
        "text": message,
        "parse_mode": "HTML"
    }
    
    try:
        response = requests.post(url, json=data, timeout=10)
        if response.status_code == 200:
            print("✅ Telegram 通知发送成功")
        else:
            print(f"❌ Telegram 通知发送失败: {response.text}")
    except Exception as e:
        print(f"❌ Telegram 通知发送异常: {e}")


def create_backup():
    """创建备份文件"""
    timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    backup_filename = f"{REPO_NAME}-backup-{timestamp}.tar.gz"
    backup_path = Path(backup_filename)
    
    print(f"📦 开始创建备份: {backup_filename}")
    
    try:
        with tarfile.open(backup_path, "w:gz") as tar:
            # 备份所有文件，包括 .github 工作流目录
            excluded = {'.git', '__pycache__', '.pytest_cache', 'venv', 'node_modules'}
            
            for item in Path('.').rglob('*'):
                # 排除特定目录和备份文件
                if any(part in excluded for part in item.parts) or item.suffix == '.gz':
                    continue
                if item.is_file():
                    print(f"  添加: {item}")
                    tar.add(item)
        
        file_size = backup_path.stat().st_size / (1024 * 1024)  # MB
        print(f"✅ 备份创建成功，大小: {file_size:.2f} MB")
        return backup_path
    except Exception as e:
        print(f"❌ 创建备份失败: {e}")
        send_telegram_message(
            f"❌ <b>备份失败</b>\n\n"
            f"仓库: <code>{REPO_NAME}</code>\n"
            f"错误: {e}"
        )
        sys.exit(1)


def upload_to_webdav(backup_path):
    """上传到 WebDAV"""
    if not WEBDAV:
        print("❌ WebDAV 配置未设置")
        return False
    
    try:
        username, password = WEBDAV.split('-----', 1)
    except ValueError:
        print("❌ WebDAV 配置格式错误，应为: username-----password")
        return False
    
    upload_url = WEBDAV_URL.rstrip('/') + '/' + backup_path.name
    
    print(f"📤 上传到 WebDAV")
    
    try:
        with open(backup_path, 'rb') as f:
            response = requests.put(
                upload_url,
                auth=(username, password),
                data=f,
                timeout=600  # 10分钟超时
            )
        
        if 200 <= response.status_code < 300:
            print(f"✅ 上传成功 (HTTP {response.status_code})")
            return True
        else:
            print(f"❌ 上传失败 (HTTP {response.status_code})")
            print(f"响应内容: {response.text[:200]}")
            send_telegram_message(
                f"❌ <b>上传失败</b>\n\n"
                f"仓库: <code>{REPO_NAME}</code>\n"
                f"HTTP 状态: {response.status_code}"
            )
            return False
    except Exception as e:
        print(f"❌ 上传异常: {e}")
        send_telegram_message(
            f"❌ <b>上传异常</b>\n\n"
            f"仓库: <code>{REPO_NAME}</code>\n"
            f"错误: {e}"
        )
        return False


def list_webdav_backups():
    """列出 WebDAV 上的备份文件"""
    if not WEBDAV:
        return []
    
    try:
        username, password = WEBDAV.split('-----', 1)
    except ValueError:
        return []
    
    try:
        response = requests.request(
            'PROPFIND',
            WEBDAV_URL,
            auth=(username, password),
            headers={'Depth': '1'},
            timeout=30
        )
        
        if response.status_code != 207:
            print(f"⚠️ 获取备份列表失败 (HTTP {response.status_code})")
            return []
        
        # 解析 WebDAV 响应
        ns = {'d': 'DAV:'}
        root = ET.fromstring(response.content)
        
        backups = []
        for response_elem in root.findall('d:response', ns):
            href = response_elem.find('d:href', ns)
            if href is not None:
                filename = href.text.rstrip('/').split('/')[-1]
                # 只匹配当前仓库的备份文件
                if filename.startswith(f"{REPO_NAME}-backup-") and filename.endswith('.tar.gz'):
                    backups.append(filename)
        
        # 按文件名排序（时间戳）
        backups.sort(reverse=True)
        print(f"📋 找到 {len(backups)} 个备份文件")
        for backup in backups:
            print(f"  - {backup}")
        return backups
    except Exception as e:
        print(f"⚠️ 获取备份列表异常: {e}")
        return []


def delete_old_backups():
    """删除旧备份，只保留最新的 MAX_BACKUPS 个"""
    backups = list_webdav_backups()
    
    if len(backups) <= MAX_BACKUPS:
        print(f"✅ 当前备份数 ({len(backups)}) 未超过限制 ({MAX_BACKUPS})")
        return
    
    to_delete = backups[MAX_BACKUPS:]
    print(f"🗑️ 需要删除 {len(to_delete)} 个旧备份")
    
    try:
        username, password = WEBDAV.split('-----', 1)
    except ValueError:
        return
    
    deleted_count = 0
    for filename in to_delete:
        delete_url = WEBDAV_URL.rstrip('/') + '/' + filename
        try:
            response = requests.delete(
                delete_url,
                auth=(username, password),
                timeout=30
            )
            
            if 200 <= response.status_code < 300:
                print(f"  ✅ 删除成功: {filename}")
                deleted_count += 1
            else:
                print(f"  ⚠️ 删除失败 (HTTP {response.status_code}): {filename}")
        except Exception as e:
            print(f"  ⚠️ 删除异常: {filename} - {e}")
    
    print(f"🗑️ 成功删除 {deleted_count}/{len(to_delete)} 个旧备份")


def main():
    print("=" * 60)
    print(f"🚀 开始备份 GitHub 仓库: {REPO_NAME}")
    print(f"⏰ 时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)
    
    # 创建备份
    backup_path = create_backup()
    
    # 上传到 WebDAV
    upload_success = upload_to_webdav(backup_path)
    
    # 获取文件大小用于通知
    file_size = backup_path.stat().st_size / (1024 * 1024)  # MB
    
    # 删除本地备份文件
    if backup_path.exists():
        backup_path.unlink()
        print(f"🗑️ 删除本地备份文件: {backup_path.name}")
    
    # 删除旧备份
    if upload_success:
        delete_old_backups()
        
        # 发送成功通知
        send_telegram_message(
            f"✅ <b>备份成功</b>\n\n"
            f"仓库: <code>{REPO_NAME}</code>\n"
            f"文件: <code>{backup_path.name}</code>\n"
            f"大小: {file_size:.2f} MB\n"
            f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        )
    
    print("=" * 60)
    print("✅ 备份脚本执行完毕")
    print("=" * 60)


if __name__ == '__main__':
    main()
