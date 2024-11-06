import { ResponseInfo } from "@/types";
import sharp from 'sharp'
import { LRUCache } from 'lru-cache'

// 创建LRU缓存实例
const transparencyCache = new LRUCache<string, boolean>({
  max: 5000, // 最多缓存5000个结果
  ttl: 1000 * 60 * 60 * 24, // 24小时过期
})
// Fetch favicons from a given URL and return ResponseInfo
export const getFavicons = async ({ url, headers }: { url: string, headers?: Headers }): Promise<ResponseInfo> => {
  const newUrl = new URL(url); // Create a URL object to extract the host
  console.log("getFavicons", newUrl.toString())
  try {
    // Perform the fetch request with optional headers and redirection follow
    const response = await fetch(newUrl.toString(), {
      method: "GET",
      redirect: "follow",
      headers
    });

    const body = await response.text();
    const responseUrl = new URL(response.url);

    // Regex to match <link> tags with "rel" containing "icon"
    const regex = /<link[^>]*rel=['"][^'"]*icon[^'"]*['"][^>]*>/gi;
    const matches = Array.from(body.matchAll(regex));
    const icons: { sizes: string, href: string }[] = [];

    matches.forEach((match) => {
      const linkTag = match[0];

      // Extract href value
      const hrefMatch = linkTag.match(/href=['"](.*?)['"]/i);
      const href = hrefMatch ? hrefMatch[1] : null;

      // Extract sizes value
      const sizesMatch = linkTag.match(/sizes=['"](.*?)['"]/i);
      const sizes = sizesMatch ? sizesMatch[1] : null;

      if (href) {
        let newHref = (href.startsWith('http') || href.startsWith('data:image')) ? href : `${responseUrl.protocol}//${responseUrl.host}${/^\/.*/.test(href) ? href : `/${href}`}`
        if (href.startsWith('//')) {
          newHref = `${responseUrl.protocol}${href}`
        }
        icons.push({
          sizes: sizes || 'unknown',
          href: newHref
        });
      }
    });

    return {
      url: responseUrl.href,
      host: responseUrl.host,
      status: response.status,
      statusText: response.statusText,
      icons
    };
  } catch (error: any) {
    console.error(`Error fetching favicons: ${error.message}`);
    return {
      url: newUrl.href,
      host: newUrl.host,
      status: 500,
      statusText: 'Failed to fetch icons',
      icons: []
    };
  }
};

// Function to fetch favicon from alternative sources
export const proxyFavicon = async ({ domain }: { domain: string; }) => {
  console.log("proxyFavicon", domain)
  // List of alternative sources to fetch favicons
  const sources = [
    `https://www.google.com/s2/favicons?domain=${domain}`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    // `https://icon.horse/icon/${domain}`
  ];
  let response: Response = new Response("", {
    status: 500
  });

  // Attempt to fetch favicon from each source
  for (const source of sources) {
    try {
      response = await fetch(source, {
        redirect: 'follow'
      });
      if (response.ok) {
        console.log("icon source ok:", source);
        break;
      }
    } catch (error: any) {
      console.error(`Error fetching proxy favicon: ${error.message}`, source);
    }
  }
  if (!response.ok) {
    const firstLetter = domain.charAt(0).toUpperCase();
    const svgContent = `
      <svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#cccccc"/>
        <text x="50%" y="50%" font-size="48" text-anchor="middle" dominant-baseline="middle" fill="#000000">${firstLetter}</text>
      </svg>
    `;
    return new Response(svgContent, {
      status: 404,
      headers: {
        'Cache-Control': 'public, max-age=86400',
        'Content-Type': 'image/svg+xml'
      }
    });
  } else {
    // Return the fetched favicon
    return new Response(response.body, {
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'image/x-icon',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

};


export async function hasTransparentEdges(imageData: ArrayBuffer): Promise<boolean> {
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