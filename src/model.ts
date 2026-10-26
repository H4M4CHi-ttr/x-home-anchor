export type Timeline = `${number}:${string}`;
export type State = 'outside' | 'active' | 'unrecognized';
export interface PostBox { element: HTMLElement; top: number; bottom: number }
export interface Post extends PostBox { id: string }
export interface PostSample {
  posts: Post[];
  boxes: PostBox[];
  overLimit: boolean;
}
export interface Anchor { id: string; top: number }
