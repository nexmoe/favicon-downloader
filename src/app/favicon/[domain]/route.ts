import { getFavicons, proxyFavicon } from '@/lib/server'
import { ResponseInfo } from '@/types'
import { LRUCache } from 'lru-cache'
import type { NextRequest } from 'next/server'
import sharp from 'sharp'

// 创建LRU缓存实例
const transparencyCache = new LRUCache<string, boolean>({
	max: 5000, // 最多缓存5000个结果
	ttl: 1000 * 60 * 60 * 24, // 24小时过期
})

async function hasTransparentEdges(imageData: ArrayBuffer): Promise<boolean> {
	// 使用图片数据的哈希作为缓存key
	const cacheKey = Buffer.from(imageData).toString('base64').slice(0, 50) // 只取前50个字符作为key

	// 检查缓存
	const cachedResult = transparencyCache.get(cacheKey)
	if (cachedResult !== undefined) {
		return cachedResult
	}

	// 如果缓存中没有,执行透明度检查
	try {
		const image = sharp(Buffer.from(imageData))
		const { width, height, channels } = await image.metadata()

		// 获取图片像素数据
		const pixels = await image.raw().toBuffer()

		let result = false

		// 检查顶部和底部边缘
		for (let x = 0; x < width!; x++) {
			const topPixel = pixels.slice((x * channels!), (x * channels!) + channels!)
			const bottomPixel = pixels.slice(((height! - 1) * width! + x) * channels!, ((height! - 1) * width! + x) * channels! + channels!)

			if (channels === 4 && (topPixel[3] === 0 || bottomPixel[3] === 0)) {
				result = true
				break
			}
		}

		if (!result) {
			// 检查左右边缘
			for (let y = 0; y < height!; y++) {
				const leftPixel = pixels.slice((y * width!) * channels!, (y * width!) * channels! + channels!)
				const rightPixel = pixels.slice((y * width! + width! - 1) * channels!, (y * width! + width! - 1) * channels! + channels!)

				if (channels === 4 && (leftPixel[3] === 0 || rightPixel[3] === 0)) {
					result = true
					break
				}
			}
		}

		// 缓存结果
		transparencyCache.set(cacheKey, result)
		return result
	} catch (error) {
		console.error('Error checking transparent edges:', error)
		return false
	}
}

async function tryGetFavicons(protocol: string, domain: string, headers: Headers) {
	try {
		const url = `${protocol}://${domain}`
		const data = await getFavicons({ url, headers })
		return data.icons
	} catch (error) {
		console.error(`Error fetching icons with ${protocol}:`, error)
		return []
	}
}

export async function GET(request: NextRequest, { params: { domain } }: { params: { domain: string } }) {
	let icons: { sizes?: string; href: string }[] = []
	const larger: boolean = request.nextUrl.searchParams.get('larger') === 'true' // Get the 'larger' parameter
	const minSize: number = parseInt(request.nextUrl.searchParams.get('minSize') || '0', 10) // 添加最小尺寸参数
	const autoPadding: boolean = request.nextUrl.searchParams.get('autoPadding') === 'true' // 添加自动填充参数
	const rounded: number = parseInt(request.nextUrl.searchParams.get('rounded') || '0', 10) // 添加圆角参数
	let selectedIcon: { sizes?: string; href: string } | undefined

	// Record start time
	const startTime = Date.now()

	// Convert the domain to ASCII encoding using URL API and remove app/web prefix if present
	let asciiDomain = new URL(`http://${domain}`).hostname
	asciiDomain = asciiDomain.replace(/^(app\.|web\.)/i, '')

	const svg404 = () => {
		const firstLetter = domain.charAt(0).toUpperCase()
		const svgContent = `
        <svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#cccccc"/>
          <text x="50%" y="50%" font-size="48" text-anchor="middle" dominant-baseline="middle" fill="#000000">${firstLetter}</text>
        </svg>
      `
		return new Response(svgContent, {
			status: 404,
			headers: {
				'Cache-Control': 'public, max-age=86400',
				'Content-Type': 'image/svg+xml',
			},
		})
	}

	// Validate domain name format
	if (!/([a-z0-9-]+\.)+[a-z0-9]{1,}$/.test(asciiDomain)) {
		return svg404()
	}

	if (larger) {
		const duckduckgoUrl = `https://icons.duckduckgo.com/ip3/${asciiDomain}.ico`
		console.log('Ico source:', duckduckgoUrl)
		try {
			const response = await fetch(duckduckgoUrl, {
				redirect: 'follow',
			})
			if (response.ok) {
				return response
			}
		} catch (error: any) {
			console.error('duckduckgo larger', error.message)
		}
	}

	let data: ResponseInfo = { url: '', host: '', status: 500, statusText: '', icons: [] }

	// Initialize headers, excluding 'Content-Length'
	const headers = new Headers(request.headers)
	headers.delete('host')
	headers.delete('Content-Length')

	// 在 GET 函数中替换原有代码
	icons = await tryGetFavicons('https', asciiDomain, headers)
	console.log("icons", icons)
	if (icons.length === 0) {
		icons = await tryGetFavicons('http', asciiDomain, headers)
	}

	// 如果子域名没有找到图标，尝试使用主域名
	if (icons.length === 0) {
		// 获取主域名的函数
		const getMainDomain = (domain: string) => {
			const parts = domain.split('.')
			// 处理特殊的二级域名后缀，如 .gov.cn, .com.cn, .edu.cn 等
			if (
				parts.length > 2 &&
				((parts[parts.length - 2] === 'gov' && parts[parts.length - 1] === 'cn') ||
					(parts[parts.length - 2] === 'com' && parts[parts.length - 1] === 'cn') ||
					(parts[parts.length - 2] === 'edu' && parts[parts.length - 1] === 'cn'))
			) {
				return parts.slice(-3).join('.')
			}
			return parts.slice(-2).join('.')
		}

		const mainDomain = getMainDomain(asciiDomain)
		if (mainDomain !== asciiDomain) {
			// 先尝试 HTTPS，失败后尝试 HTTP
			icons = await tryGetFavicons('https', mainDomain, headers)

			if (icons.length === 0) {
				icons = await tryGetFavicons('http', mainDomain, headers)
			}
		}
	}

	// 如果仍然没有找到图标，使用备选方案
	if (icons.length === 0) {
		return proxyFavicon({ domain: asciiDomain })
	}

	// Select the appropriate icon based on the 'larger' parameter
	if (larger) {
		selectedIcon = icons.reduce((prev, curr) => {
			const prevWidth = parseInt((prev.sizes || '0x0').split('x')[0], 10)
			const currWidth = parseInt((curr.sizes || '0x0').split('x')[0], 10)

			// 如果设置了最小尺寸，优先选择满足最小尺寸的图标
			if (minSize > 0) {
				if (currWidth >= minSize && (prevWidth < minSize || currWidth > prevWidth)) {
					return curr
				}
				if (currWidth > prevWidth) {
					return curr
				}
				return prev
			}

			return currWidth > prevWidth ? curr : prev
		})
	} else {
		// 对于非larger模式，如果指定了最小尺寸，尝试找到满足要求的图标
		if (minSize > 0) {
			// 先尝试找到满足最小尺寸图标
			selectedIcon = icons.find((icon) => {
				const width = parseInt((icon.sizes || '0x0').split('x')[0], 10)
				return width >= minSize
			})

			// 如果没找到满足最小尺寸的图标，就使用最大的那个
			if (!selectedIcon) {
				selectedIcon = icons.reduce((prev, curr) => {
					const prevWidth = parseInt((prev.sizes || '0x0').split('x')[0], 10)
					const currWidth = parseInt((curr.sizes || '0x0').split('x')[0], 10)
					return currWidth > prevWidth ? curr : prev
				})
			}
		} else {
			selectedIcon = icons[0]
		}
	}

	// 提取创建SVG包装的通用函数
	function createSvgWrapper(imageData: string, contentType: string, padding: number) {
		const imageSize = 100 - (padding * 2);
		return `
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
				<defs>
					<pattern id="img" x="${padding}" y="${padding}" width="${imageSize}" height="${imageSize}" patternUnits="userSpaceOnUse">
						<image x="0" y="0" width="${imageSize}" height="${imageSize}" preserveAspectRatio="xMidYMid meet" 
							href="data:${contentType};base64,${imageData}"/>
					</pattern>
				</defs>
				<rect width="100" height="100" fill="transparent"/>
				<rect x="${padding}" y="${padding}" width="${imageSize}" height="${imageSize}" fill="url(#img)"/>
			</svg>`;
	}

	// 提取创建Response的通用函数
	function createSvgResponse(svgContent: string, executionTime: number) {
		return new Response(svgContent, {
			status: 200,
			headers: {
				'Cache-Control': 'public, max-age=86400',
				'Content-Type': 'image/svg+xml',
				'X-Execution-Time': `${executionTime}ms`,
			},
		});
	}

	try {
		const endTime = Date.now();
		const executionTime = endTime - startTime;
		
		let base64Data: string;
		let contentType: string;
		let buffer: ArrayBuffer;
		
		if (selectedIcon.href.includes('data:image')) {
			base64Data = selectedIcon.href.split(',')[1];
			buffer = Buffer.from(base64Data, 'base64');
			contentType = selectedIcon.href.replace(/data:(image.*?);.*/, '$1');
		} else {
			const iconResponse = await fetch(selectedIcon.href, { headers });
			if (!iconResponse.ok) return svg404();
			
			buffer = await iconResponse.arrayBuffer();
			contentType = iconResponse.headers.get('Content-Type') || 'image/png';
			base64Data = Buffer.from(buffer).toString('base64');
		}
		
		const hasTransparentEdge = autoPadding ? await hasTransparentEdges(buffer) : false;
		const padding = (autoPadding && hasTransparentEdge) ? 10 : 0;
		
		const svgWrapper = createSvgWrapper(base64Data, contentType, padding);
		return createSvgResponse(svgWrapper, executionTime);
	} catch (error) {
		console.error(`Error fetching the selected icon:`, error);
		return new Response('Failed to fetch the icon', { status: 500 });
	}
}
