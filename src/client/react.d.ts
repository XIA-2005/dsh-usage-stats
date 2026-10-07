/**
 * 极简 react 类型声明。
 *
 * client bundle 把 react 当外部依赖（tsdown 的 neverBundle），产物里是
 * `require("react")`；插件目录不装 @types/react，这里只手写用到的几个 API，
 * 让 tsc 通过而不引入任何运行时依赖。
 */
declare module 'react' {
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  export function useRef<T>(initial: T): { current: T }
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}
