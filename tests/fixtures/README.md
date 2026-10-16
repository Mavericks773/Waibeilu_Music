# 自生成的 Ogg 测试样本

tone-vorbis.ogg 和 tone-opus.ogg 均为本项目生成的 440 Hz 正弦波，单声道、48 kHz、约两秒，不包含第三方录音。

使用 NumPy 生成振幅 0.12 的浮点采样，并通过 Python soundfile / libsndfile 分别编码为 OGG/VORBIS、OGG/OPUS。编码工具只用于生成这些固定样本，不是应用或测试运行时依赖。现有用户提供的 yumetohazakura.mp3 继续用于 MP3 回归测试。
