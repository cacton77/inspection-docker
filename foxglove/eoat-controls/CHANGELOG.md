# EOAT Controls version history

## 0.3.0

- **EOAT Focus**: hold-to-move, step jog, go-to and range calibration for the focus lens,
  through `lens_tuner`'s `/camera_head/lens/request`.
- **PLM Catalog**: browse, select and sync parts through plm_bridge's `/catalog/*` services.
- **Viewpoint Generation**: run the pipeline stages and step through regions and clusters
  drawn by `foxglove_viz_node` in a 3D panel.

## 0.1.0

- **EOAT Lighting**: solid, ring and spot modes for the macro-ps LED ring, through
  `lens_tuner`'s `/camera_head/led_ring/request`.
