
一共两个节点 按需使用，需要单独放入comfyui目录

一.画廊输出的是图片元数据 可以通过ai进行提取提示词等信息 如果有的话
comfyui标出的图 可以直接拖出来就有工作流 但是工作流五花八门 能看到啥就看运气了
<img width="1769" height="861" alt="Snipaste_2026-05-20_15-15-51" src="https://github.com/user-attachments/assets/ef994921-4c45-42f0-9d36-d04c1c87bf58" />






<img width="1345" height="931" alt="image" src="https://github.com/user-attachments/assets/e71c7571-4bde-4866-8a0d-14fdd01f9a09" />

不然的话就只能反推出图了


二.TAG提示词库融合的Danbooru / NovelAI 标签超市https://github.com/wfjsw/danbooru-diffusion-prompt-builder
和AI咒语https://docs.google.com/spreadsheets/d/16wR5Zg_aQEbxLdrTOrB9cZf8QmsMrJnSGxFKbZVtrKc/edit?pli=1&gid=130296309#gid=130296309。
差不多5000左右个词
<img width="1626" height="701" alt="image" src="https://github.com/user-attachments/assets/0e59f1c3-df70-48b6-8055-26eca1cf2784" />
滚轮增减权重
翻译节点用的danbooru_tags数据 22W词条本地翻译，上游的输入实时更新 也可以切换权重继续输出下游，留着当个翻译器也不错
<img width="1552" height="611" alt="image" src="https://github.com/user-attachments/assets/b7b94a1d-8041-4a76-93af-6979e1d9000f" />
