import { getFavicons, proxyFavicon } from '@/lib/server'
import { ResponseInfo } from '@/types'
import type { NextRequest } from 'next/server'
import sharp from 'sharp'

async function hasTransparentEdges(imageData: ArrayBuffer): Promise<boolean> {
	// 使用 sharp 库来处理图片
	const image = sharp(Buffer.from(imageData));
	const { width, height, channels } = await image.metadata();
	
	// 获取图片像素数据
	const pixels = await image.raw().toBuffer();
	
	// 检查顶部和底部边缘
	for (let x = 0; x < width; x++) {
	  // 顶部边缘
	  const topPixel = pixels.slice((x * channels), (x * channels) + channels);
	  // 底部边缘
	  const bottomPixel = pixels.slice(((height - 1) * width + x) * channels, ((height - 1) * width + x) * channels + channels);
	  
	  if (channels === 4 && (topPixel[3] === 0 || bottomPixel[3] === 0)) {
		return true;
	  }
	}
	
	// 检查左右边缘
	for (let y = 0; y < height; y++) {
	  // 左边缘
	  const leftPixel = pixels.slice((y * width) * channels, (y * width) * channels + channels);
	  // 右边缘
	  const rightPixel = pixels.slice((y * width + width - 1) * channels, (y * width + width - 1) * channels + channels);
	  
	  if (channels === 4 && (leftPixel[3] === 0 || rightPixel[3] === 0)) {
		return true;
	  }
	}
	
	return false;
  }

export async function GET(request: NextRequest, { params: { domain } }: { params: { domain: string } }) {
	let icons: { sizes?: string; href: string }[] = []
	const larger: boolean = request.nextUrl.searchParams.get('larger') === 'true' // Get the 'larger' parameter
	const minSize: number = parseInt(request.nextUrl.searchParams.get('minSize') || '0', 10) // 添加最小尺寸参数
	const autoPadding: boolean = request.nextUrl.searchParams.get('autoPadding') === 'true' // 添加自动填充参数
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

	let url = `http://${asciiDomain}`
	try {
		// 尝试使用 HTTP 获取图标
		data = await getFavicons({ url, headers })
		icons = data.icons
	} catch (error) {
		console.error(error)
	}

	if (icons.length === 0) {
		url = `https://${asciiDomain}`
		try {
			// 尝试使用 HTTPS 获取图标
			const data = await getFavicons({ url, headers })
			icons = data.icons
		} catch (error) {
			console.error(error)
		}
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
			try {
				// 先尝试 HTTPS
				const mainDomainData = await getFavicons({
					url: `https://${mainDomain}`,
					headers,
				})
				icons = mainDomainData.icons
			} catch (error) {
				console.error(error)
				try {
					// 如果 HTTPS 失败，尝试 HTTP
					const mainDomainData = await getFavicons({
						url: `http://${mainDomain}`,
						headers,
					})
					icons = mainDomainData.icons
				} catch (error) {
					console.error(error)
				}
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

	try {
		if (selectedIcon.href.includes('data:image')) {
			const base64Data = selectedIcon.href.split(',')[1]
			const endTime = Date.now()
			const executionTime = endTime - startTime

			// 解码base64数据来检查透明边缘
			const buffer = Buffer.from(base64Data, 'base64')
			const hasTransparentEdge = autoPadding ? await hasTransparentEdges(buffer) : false
			
			// 计算边距和图像尺寸
			const padding = (autoPadding && hasTransparentEdge) ? 10 : 0
			const imageSize = 100 - (padding * 2)

			// 创建带边距的SVG包装
			const svgWrapper = `
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
				<defs>
					<pattern id="img" x="${padding}" y="${padding}" width="${imageSize}" height="${imageSize}" patternUnits="userSpaceOnUse">
						<image x="0" y="0" width="${imageSize}" height="${imageSize}" preserveAspectRatio="xMidYMid meet" 
							href="data:${selectedIcon.href.replace(/data:(image.*?);.*/, '$1')};base64,${base64Data}"/>
					</pattern>
				</defs>
				<rect width="100" height="100" fill="transparent"/>
				<rect x="${padding}" y="${padding}" width="${imageSize}" height="${imageSize}" fill="url(#img)"/>
			</svg>`

			return new Response(svgWrapper, {
				status: 200,
				headers: {
					'Cache-Control': 'public, max-age=86400',
					'Content-Type': 'image/svg+xml',
					'X-Execution-Time': `${executionTime} ms`,
				},
			})
		}

		const iconResponse = await fetch(selectedIcon.href, { headers });
		const endTime = Date.now();
		const executionTime = endTime - startTime;
		if (!iconResponse.ok) return svg404();
		const iconBuffer = await iconResponse.arrayBuffer();
		const contentType = iconResponse.headers.get('Content-Type') || 'image/png';

		// 只在 autoPadding 为 true 时才检查边缘
		const hasTransparentEdge = autoPadding ? await hasTransparentEdges(iconBuffer) : false;
		
		// 只有当 autoPadding 为 true 且有透明边缘时才添加边距
		const padding = (autoPadding && hasTransparentEdge) ? 10 : 0;
		const imageSize = 100 - (padding * 2);
		
		const svgWrapper = `
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
			<defs>
				<pattern id="img" x="${padding}" y="${padding}" width="${imageSize}" height="${imageSize}" patternUnits="userSpaceOnUse">
					<image x="0" y="0" width="${imageSize}" height="${imageSize}" preserveAspectRatio="xMidYMid meet" 
						href="data:${contentType};base64,${Buffer.from(iconBuffer).toString('base64')}"/>
				</pattern>
			</defs>
			<rect width="100" height="100" fill="transparent"/>
			<rect x="${padding}" y="${padding}" width="${imageSize}" height="${imageSize}" fill="url(#img)"/>
		</svg>`;

		return new Response(svgWrapper, {
			status: 200,
			headers: {
				'Cache-Control': 'public, max-age=86400',
				'Content-Type': 'image/svg+xml',
				'X-Execution-Time': `${executionTime}ms`,
			},
		})
	} catch (error) {
		console.error(`Error fetching the selected icon: ${error}`)
		return new Response('Failed to fetch the icon', { status: 500 })
	}
}
