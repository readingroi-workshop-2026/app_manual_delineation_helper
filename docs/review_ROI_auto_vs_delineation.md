# Visual review: tiger_ROI_auto vs tiger_delineation

逐个被试目视比较新旧两版 word-ROI delineation，左半球（lh）。

| | 参考 ref（compare 页面上排） | 比较 compare（下排） |
|---|---|---|
| 文件夹 | `label/tiger_delineation/` | `label/tiger_ROI_auto/` |
| 新旧 | 旧 | 新 |
| 对比 | RWvsSC（real words vs scrambled words） | RWvsAllNotext（auto clusters） |
| 框架 | 5 个 ROI：IOG、PON、pOTS、mOTS、mFus；IOG 和 MOG 不区分 | 6 个 ROI：多了 LOC；IOG 和 MOG 分开 |

**记录约定**
- 写法是"新相对于旧"（tiger_ROI_auto 相对 tiger_delineation）。
- **不变** 指相对位置 / ROI 中心没变。因为换了对比，新 ROI 普遍可能更小，大小变化不算"变"；如果特别明显，写在备注里。
- 状态码：
  - `=` 不变
  - `→方向` 移位，例如 `→medial`、`→lateral`、`→anterior`、`→posterior`
  - `+` 新增
  - `−` 消失
  - `?` 不确定 / 待复查
  - `−部分` 一部分消失
  - `形状变` 中心大致在，但形状或分布变了
- 打开方式：`/compare`，ref = tiger_delineation，compare = tiger_ROI_auto。

## 总览

| sub | mFus | mOTS | pOTS | PON | IOG | LOC | 状态 |
|---|---|---|---|---|---|---|---|
| 01 | = | = | = | = | = | + | 已看 |
| 02 | = | = | = | = | →medial | + | 已看 |
| 03 | = | = | −部分 | 形状变 | →anterior | + | 已看 |
| 04 | = | = | −部分 | = | −部分 | + | 已看 |
| 05 | 移位（占旧 mOTS） | →lateral（ITG） | −部分 | = | →medial | + | 已看 |
| 06 | = | = | = | = | = | + | 已看 |
| 07 | = | = | = | = | 形状变 | + | 已看 |
| 08 | →OTS | −部分（只剩 lateral） | = | = | = | + | 已看 |
| 09 | = | = | = | = | →medial | + | 已看 |
| 10 | = | = | −部分（去掉 ITG 部分） | = | = | + | 已看 |
| 11 | = | −部分（去掉 ITG 部分） | −部分（去掉 PON 部分） | 移位（占旧 pOTS 的 PON 部分） | 移位（占旧 PON） | +（占旧 IOG） | 已看 |

## 逐个被试

### sub-01（2026-10-06）
- mFus：不变
- mOTS：不变
- pOTS：不变
- PON：不变
- IOG：不变
- LOC：新增。来自一个以前没有考虑的 cluster：在 inflated surface 上看起来更 posterior，在 pial surface 上看，它其实不在 posterior，而在 lateral。没有占用旧 IOG 的位置
- 备注：

### sub-02（2026-10-06）
- mFus：不变
- mOTS：不变
- pOTS：不变
- PON：不变
- IOG：变得更 medial；以前的 IOG 在 lateral
- LOC：新增，占据了以前 IOG 的位置
- 备注：新对比下 ROI 可能更小；"不变"指相对位置 / ROI 中心没变。

### sub-03（2026-10-06）
- mFus：不变
- mOTS：不变
- pOTS：有些变化，fusiform 里的一个 sub-part 在新对比下消失了
- PON：变化。以前上下分布，现在左右分布；以前上面那部分保留了，下面那部分划给了新的 IOG
- IOG：更靠前（anterior）。这次更对：上次的定位超出了 IOG，太 posterior 了
- LOC：新增，在 lateral surface
- 备注：

### sub-04（2026-10-06）
- mFus：不变
- mOTS：不变
- pOTS：以前有 medial 和 lateral 两个 sub-part；因为新对比加上对 OTS 更精确的分割，现在只保留了落在 OTS 里的那个 sub-part
- PON：不变
- IOG：保留了以前 IOG 的 anterior 部分
- LOC：新增，占据了以前 IOG 的 posterior 部分。在 inflated surface 上看起来是前后关系，其实因为皮层褶皱，它是在 lateral
- 备注：IOG 和 LOC 一起，相当于把旧 IOG 拆成前（IOG）后（LOC）两块

### sub-05（2026-10-06）
- mFus：变化，现在的 mFus 占据了以前 mOTS 的位置；用 face ROI 核对过，这次是对的
- mOTS：变化，现在在 OTS 的 lateral，位于 ITG
- pOTS：变化，少了以前在 PON 里的一个 sub-part，这样更好
- PON：不变
- IOG：变化，现在在更 medial 的位置，但该位置在解剖上确实是 IOG
- LOC：新增，在 inflated surface 上占据了以前 IOG 的位置，在 pial surface 上位于 lateral
- 备注：mFus 和 mOTS 整体往 lateral 方向移了一格（mFus → 旧 mOTS 的位置，mOTS → ITG）

### sub-06（2026-10-06）
- mFus：不变
- mOTS：不变
- pOTS：不变
- PON：不变
- IOG：不变
- LOC：新增。来自一个以前没有考虑的 cluster：在 inflated surface 上看起来更 posterior，在 pial surface 上看，它其实不在 posterior，而在 lateral。没有占用旧 IOG 的位置
- 备注：和 sub-01 相同

### sub-07（2026-10-06）
- mFus：不变
- mOTS：不变
- pOTS：不变
- PON：不变
- IOG：变化。以前是中、上两个 sub-part，现在去掉了上面那个，加入了下面的一个 sub-part
- LOC：新增，一个以前没有考虑的 lateral ROI；没有占用旧 IOG 的位置
- 备注：

### sub-08（2026-10-06）
- mFus：变化，移到了 OTS 上。原因是新对比：以前的 mFus 受到了 face region 的影响
- mOTS：变化，只剩下 lateral 的 sub-part，同样是新对比的影响
- pOTS：不变
- PON：不变
- IOG：不变
- LOC：新增。在 inflated surface 上位于 PON 的 lateral、IOG 的 anterior，但在 pial surface 上能看出它是一个 lateral ROI
- 备注：和 sub-05 一样，mFus 往 lateral 移（新对比排除了 face region）

### sub-09（2026-10-06）
- mFus：不变
- mOTS：不变
- pOTS：不变
- PON：不变
- IOG：变得更 medial。这个位置以前在 inflated surface 上看显得很 medial，但现在看（pial）正好落在 IOG 上
- LOC：新增，在 inflated surface 上占据了以前 IOG 的位置；在 pial surface 上看，它应属于 lateral surface
- 备注：和 sub-02、05 同一模式：IOG 往 medial 移，LOC 接替旧 IOG 的位置

### sub-10（2026-10-06）
- mFus：不变
- mOTS：不变
- pOTS：变化，保留了 OTS 内部的 sub-part；以前还有一个 lateral 的部分，解剖上在 ITG，离得太远，所以这次不考虑
- PON：不变
- IOG：不变
- LOC：新增，在 inflated surface 上离以前的 IOG 很近，但在 pial surface 上位于 lateral
- 备注：pOTS 的改变和 sub-04 相同：只保留落在 OTS 里的 sub-part

### sub-11（2026-10-06）
- mFus：不变
- mOTS：不变，但少了一个在 ITG 的 sub-part，因为解剖更准确了
- pOTS：保留了在 OTS 内的 sub-part，去掉了在 PON 的 sub-part
- PON：占据了以前 pOTS 落在 PON 的那个 sub-part，现在更正确
- IOG：占据了以前 PON 的位置，现在更正确
- LOC：占据了以前 IOG 的位置，更正确，现在在 lateral surface
- 备注：posterior 一端整体顺移了一格（旧 pOTS 的 PON 部分 → PON，旧 PON → IOG，旧 IOG → LOC）

## 变化原因（2026-10-06 复核）

变化来自四类原因：
- **low power**：被试的 power 很低，旧对比下的定位不可靠；
- **new contrast**：旧对比是 RWvsSC，新对比是 RW vs face + limbs + SC（RWvsAllNotext），所以 face 激活被去掉了；
- **更好的 anatomy**：结合解剖重新定位，包括定义了个体的 PON；
- **IOG / LOC 忽视或混淆**：旧框架没区分 IOG 和 LOC。"混淆"是旧"IOG"里混进了 LOC（多因为没看 pial），"忽视"是 LOC 的 cluster 以前没考虑。

**ROI × 原因**

| ROI | 变化被试 | low power | new contrast | 更好的 anatomy | IOG / LOC 忽视或混淆 |
|---|---|---|---|---|---|
| mFus | 05、08 | 05、08 | 05、08 | | |
| mOTS | 05、08、11 | 05（间接） | 05（间接） | 08、11 | |
| pOTS | 03、04、05、10、11 | | 03 | 04、05、10、11 | |
| PON | 03、11 | | | 03、11 | |
| IOG | 02、03、04、05、07、09、11 | | 07 | 02、03、07、11 | 02、04、05、09（混淆） |
| LOC | 全部 11 名 | | | | 02、04、05、09、11（混淆）；01、06、07、08、10（忽视） |

**逐条原因**

| ROI | 被试 | 变化 | 原因 |
|---|---|---|---|
| mFus | 05、08 | 往 lateral 移 | low power + new contrast：两人 power 都很低，旧对比下的 mFus 是 face 激活，新对比把它去掉了 |
| mOTS | 05 | 新位置：比以前更 lateral、posterior，靠近 ITG（这个位置没问题） | 间接：旧 mOTS 的位置被新的 mFus 占了，所以另找了 mOTS |
| mOTS | 08、11 | 只保留一部分 | 更好的 anatomy：现在的位置更好 |
| pOTS | 03 | fusiform 里的 sub-part 消失 | new contrast |
| pOTS | 04、05、10、11 | 只保留 OTS 内的部分 | 更好的 anatomy |
| PON | 03、11 | 重新划界 | 更好的 anatomy：定义了个体的 PON，两人的 PON 现在正好在正确的位置上 |
| IOG | 02 | 往 medial 移 | 混淆：没看 pial，以前的 IOG 应该是现在的 LOC；更好的 anatomy + pial |
| IOG | 03 | 往前移 | 更好的 anatomy：以前受错误的 PON 影响，现在在正确的解剖位置 |
| IOG | 04 | 只保留 anterior 部分 | 混淆：以前 LOC 和 IOG 混在一起，有了 pial 后分清了 |
| IOG | 05、09 | 往 medial 移 | 混淆：和 LOC 混了；IOG 重新定在解剖上更正确的地方，旧的 IOG 是现在的 LOC |
| IOG | 07 | sub-part 改变 | 更好的 anatomy + new contrast |
| IOG | 11 | 移到旧 PON 的位置 | 更好的 anatomy |
| LOC | 02、04、05、09、11 | 新增，接替旧 IOG | 混淆：旧"IOG"其实是 LOC |
| LOC | 01、06、07、08、10 | 新增，新 cluster | 忽视：以前没考虑；在 pial 上看位于 lateral |
| LOC | 03 | 新增，在 lateral surface | 未记录原因 |

## 结论（2026-10-06）

和旧版（tiger_delineation）相比，新版（tiger_ROI_auto）的改进有四点：

1. **把被误标为 IOG 的区域改为 LOC**（02、04、05、09、11）。旧版只看 inflated surface，把一些区域定成了 IOG，它们其实应该是 LOC，在 pial 上位于 lateral surface。改正之后，IOG 也回到了解剖上正确的位置：02、05、09 往 medial 移；04 只保留旧 IOG 的 anterior 部分；11 的 IOG 移到了旧 PON 的位置。
2. **大的 pOTS 只保留 OTS 内的部分**（03、04、05、10、11）。旧版有些很大的 pOTS 包含了两个在 surface 上相距很远的部分，被合并成一个 ROI。新版只保留落在 OTS 内的部分，远处的部分被去掉或重新分配：
   - 03：去掉了 fusiform 里的部分
   - 04：去掉了 medial 的部分
   - 05：去掉了 PON 里的部分
   - 10：去掉了 ITG 里的部分
   - 11：PON 里的部分划给了 PON
3. **两个被试的 mFus 往 lateral 移**（05、08）。旧 mFus 的位置受到 face 效应的污染；新对比去掉了这个影响，mFus 移到了更 lateral 的地方：05 移到旧 mOTS 的位置（用 face ROI 核对过），08 移到 OTS 上。
4. **加了 pial surface 以后，IOG 和 LOC 分得更清楚**（01、06、07、08、10；03 大概也算）。以前在 inflated 上分不清的 cluster，在 pial 上看能确定属于 lateral surface，于是作为 LOC **新加入**，原来的 IOG 不受影响。这一点和第 1 点的区别是：第 1 点是旧 IOG **改名**为 LOC，这一点是**新增**的 cluster。两类合起来，11 个被试全部新增了 LOC。

**补充：**
- **anterior 的 ROI 很稳定。** mFus 在 9/11 个被试不变，mOTS 8/11，PON 9/11。变化集中在 posterior / lateral 一端（IOG、LOC、PON），正好是新框架要区分 IOG 和 MOG（LOC）的地方。
- **mOTS 有 3 个被试调整（05、08、11）：** 05 移到 ITG（lateral to OTS）；08 只剩 lateral 部分（新对比的影响）；11 去掉了 ITG 里的部分（解剖更准确）。
- **PON 有 2 个被试调整（03、11）：** 03 从上下分布变成左右分布，下面那部分划给了新 IOG；11 接收了旧 pOTS 落在 PON 的部分。
- **IOG 的其他调整：** 03 往 anterior 移（旧版太 posterior、超出了 IOG）；07 去掉了上面的 sub-part，加入了下面的 sub-part。
- **sub-11 是一个连锁顺移：** 旧 pOTS 的 PON 部分 → PON，旧 PON → IOG，旧 IOG → LOC。
- **没有哪个被试被记为新版更差。** 多处明确记了"更对 / 更正确"：03 IOG，05 mFus 和 pOTS，11 的 mOTS、PON、IOG、LOC。
- **待统一的标准：** ITG 里的激活算不算 mOTS / pOTS？05 是移入 ITG，10、11 是去掉 ITG 里的部分。写方法时需要定下来。

## 跨被试小结（详细统计）

11 个被试全部看完。

**各 ROI 的变化统计**

| ROI | 不变 | 有变化 | 变化的类型 |
|---|---|---|---|
| mFus | 9 | 2（05、08） | 往 lateral 移：05 占了旧 mOTS 的位置，08 移到了 OTS 上。新对比排除了 face region 的影响（05 用 face ROI 核对过） |
| mOTS | 8 | 3（05、08、11） | 05 移到了 ITG（lateral to OTS）；08 只剩 lateral 的 sub-part；11 去掉了 ITG 里的 sub-part |
| pOTS | 6 | 5（03、04、05、10、11） | 都是去掉了 OTS 以外的 sub-part：fusiform（03）、medial 部分（04）、PON（05、11）、ITG（10）；保留落在 OTS 里的部分 |
| PON | 9 | 2（03、11） | 03 从上下分布变成左右分布，下面那部分划给了 IOG；11 接收了旧 pOTS 落在 PON 的 sub-part |
| IOG | 4（01、06、08、10） | 7 | →medial（02、05、09）；→anterior（03）；只保留旧 IOG 的 anterior 部分（04）；sub-part 改变（07）；移到旧 PON 的位置（11） |
| LOC | — | 11 个全部新增 | 见下 |

**LOC 的来源**
- 占了旧 IOG 的位置或旧 IOG 的一部分：02、04、05、09、11（5 个）
- 以前没考虑的新 cluster，旧 IOG 基本不变：01、06、07、08、10（5 个）
- 未说明和旧 IOG 的关系，只记了在 lateral surface：03

**主要模式**
1. **anterior 的 ROI 基本稳定。** mFus、mOTS 在大多数被试里不变；变化的那几个（05、08）都是新对比去掉了 face 的影响。
2. **pOTS 变得更"干净"。** 5 个被试去掉了落在 OTS 以外（fusiform、PON、ITG、medial）的 sub-part，只留 OTS 内的部分。
3. **变化集中在 posterior / lateral 一端（IOG、LOC、PON）。** 这正是新框架要区分 IOG 和 MOG（LOC）的地方。旧框架里的"IOG"在约一半被试里其实是现在的 LOC（02、04、05、09、11）；新的 IOG 因此往 medial 移（02、05、09）。在 sub-11 里，这种顺移一直延伸到了 PON 和 pOTS。
4. **判断 LOC 位置要看 pial。** 01、04、05、06、08、09、10 都出现了同一个现象：LOC 在 inflated 上看着是 posterior，或紧挨着 IOG，在 pial 上其实在 lateral surface。
5. **新版普遍被认为更正确：** 03 IOG，05 mFus 和 pOTS，11 的 mOTS、PON、IOG、LOC，都明确记了"更对 / 更正确"。没有哪个被试被记为新版更差。

**例外 / 待复查**
- sub-05 的 mOTS 移到了 ITG，而 sub-10、11 是把 ITG 里的部分去掉。ITG 里的激活该不该算 mOTS / pOTS，标准要统一。
- sub-03 的 LOC 和旧 IOG 的关系没记。
